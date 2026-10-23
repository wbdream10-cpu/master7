import { createHash, randomUUID } from 'node:crypto';
import { sql, withStorage } from './runtime.mjs';

const PROVIDER = 'vpay';
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const tenantPattern = /^[A-Za-z0-9_-]{1,60}$/;
const requestPattern = /^[A-Za-z0-9_-]{16,100}$/;
const merchantPattern = /^[1-9]\d{0,9}$/;
const tradeCodePattern = /^[1-7]$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;
const tradeNoPattern = /^[A-Za-z0-9_-]{1,128}$/;
const reasonPattern = /^[A-Z0-9_]{3,64}$/;
const statusValues = new Set(['pending', 'paid', 'failed', 'reversed', 'risk_control', 'unknown']);

const fail = code => { throw new Error(code); };
const safe = (value, pattern) => typeof value === 'string' && pattern.test(value);
const validTime = value => typeof value === 'string' && value.length >= 20 && value.length <= 40 && Number.isFinite(Date.parse(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const instant = (clock, code = 'VPAY_QUERY_STATE_CONFLICT') => {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail(code);
  return value;
};

async function transaction(action) {
  return withStorage(async () => {
    await sql.exec('BEGIN IMMEDIATE');
    try {
      const result = await action();
      await sql.exec('COMMIT');
      return result;
    } catch (error) {
      await sql.exec('ROLLBACK');
      throw error;
    }
  });
}

async function trustedMember(userId) {
  return sql.prepare(`SELECT u.id,u.username,u.email,u.role,u.approved,
    m.tenant_id AS tenant_id,p.user_id AS staff_id
    FROM portal_users u JOIN members m ON m.email=u.email
    LEFT JOIN portal_staff p ON p.user_id=u.id WHERE u.id=?`).get(userId);
}

async function lockMember(userId) {
  // These no-op writes take database row locks before the authoritative
  // identity snapshot. They serialize role, membership, and staff changes
  // with reservation and settlement across portal instances.
  const user = await sql.prepare('UPDATE portal_users SET id=id WHERE id=?').run(userId);
  if (user.changes !== 1) return false;
  const member = await sql.prepare(`UPDATE members SET email=email
    WHERE email=(SELECT email FROM portal_users WHERE id=?)`).run(userId);
  return member.changes === 1;
}

async function exactJournal(row) {
  const journal = await sql.prepare('SELECT * FROM portal_wallet_journal WHERE order_id=?').get(row.id);
  return Boolean(journal && journal.tenant_id === row.tenant_id && journal.user_id === row.user_id &&
    journal.environment === row.environment && journal.currency === row.currency &&
    BigInt(journal.member_minor) === BigInt(row.amount_minor) &&
    BigInt(journal.clearing_minor) === -BigInt(row.amount_minor));
}

async function insertReview(row, reason, evidence, at, idFactory) {
  if (!safe(reason, reasonPattern)) fail('VPAY_REVIEW_REASON_INVALID');
  const observed = {
    amountMinor: evidence?.amountMinor == null ? null : String(evidence.amountMinor),
    currency: evidence?.currency === 'MYR' ? 'MYR' : null,
    state: typeof evidence?.state === 'string' && /^[a-z0-9_]{3,40}$/.test(evidence.state) ? evidence.state : null,
    tradeNo: safe(evidence?.tradeNo, tradeNoPattern) ? evidence.tradeNo : null,
  };
  const evidenceHash = digest({ orderId: row.id, reason, ...observed });
  await sql.prepare(`INSERT INTO portal_payment_reviews(
    id,order_id,tenant_id,reason,evidence_hash,created_at,observed_minor,observed_currency,observed_state,observed_trade_no
  ) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id,reason,evidence_hash) DO NOTHING`).run(
    idFactory(), row.id, row.tenant_id, reason, evidenceHash, at,
    observed.amountMinor, observed.currency, observed.state, observed.tradeNo,
  );
  await sql.prepare("UPDATE portal_payment_orders SET review_required=1 WHERE id=? AND provider='vpay'").run(row.id);
}

/**
 * Durable VPay state. This module performs no network requests and stores no
 * callback body, signature, API key, bearer token, provider remark, or bank
 * detail. Callers must pass only fields already validated by vpay-contract.
 */
export function createVPayStore({
  merchantId,
  environment = 'uat',
  now = () => new Date(),
  idFactory = randomUUID,
  queryLeaseMs = 120_000,
  recoveryDelayMs = 60_000,
} = {}) {
  if (!safe(merchantId, merchantPattern) || !['uat', 'production'].includes(environment) ||
      typeof now !== 'function' || typeof idFactory !== 'function' ||
      !Number.isInteger(queryLeaseMs) || queryLeaseMs < 10_000 || queryLeaseMs > 600_000 ||
      !Number.isInteger(recoveryDelayMs) || recoveryDelayMs < 60_000 || recoveryDelayMs > 3_600_000) {
    throw new TypeError('Invalid VPay store configuration');
  }

  const rowById = id => sql.prepare(`SELECT o.* FROM portal_payment_orders o
    WHERE o.id=? AND o.provider='vpay' AND o.merchant_id=? AND o.environment=?`).get(id, merchantId, environment);
  const latestQueryAttempt = (orderId, inFlight = false) => sql.prepare(`SELECT * FROM portal_vpay_attempts
    WHERE order_id=? AND operation='query' ${inFlight ? "AND outcome='in_flight'" : ''}
    ORDER BY started_at DESC,id DESC LIMIT 1`).get(orderId);

  async function project(row, attempt = undefined) {
    if (!row) return null;
    const currentAttempt = attempt === undefined ? await latestQueryAttempt(row.id) : attempt;
    // This projection is an internal server capability. queryClaimToken must
    // never be copied into an HTTP response, log, audit entry, or UI model.
    return Object.freeze({
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      requestKey: row.request_key,
      merchantId: row.merchant_id,
      environment: row.environment,
      amountMinor: String(row.amount_minor),
      currency: row.currency,
      fingerprint: row.create_fingerprint,
      tradeCode: row.trade_code,
      tradeNo: row.trade_no || null,
      createState: row.create_outcome,
      settlementStatus: row.settlement_status,
      reviewRequired: Boolean(row.review_required),
      checkoutUrl: row.checkout_url || null,
      expiresAtRaw: row.expires_at_raw || null,
      queryState: !currentAttempt ? 'idle' : currentAttempt.outcome === 'in_flight' ? 'in_flight'
        : currentAttempt.observed_status === 'paid' ? 'confirmed'
        : currentAttempt.observed_status || currentAttempt.outcome,
      queryAttemptId: currentAttempt?.outcome === 'in_flight' ? currentAttempt.id : null,
      queryClaimToken: currentAttempt?.outcome === 'in_flight' ? currentAttempt.claim_token : null,
      queryLeaseExpiresAt: currentAttempt?.outcome === 'in_flight' ? currentAttempt.lease_expires_at : null,
      callbackId: currentAttempt?.outcome === 'in_flight' ? currentAttempt.callback_id : null,
    });
  }

  async function resolveMember(user) {
    if (!user || user.role !== 'customer' || !safe(user.userId, idPattern)) fail('VPAY_MEMBER_UNAVAILABLE');
    return withStorage(async () => {
      const member = await trustedMember(user.userId);
      if (!member || member.role !== 'customer' || !member.approved || member.staff_id ||
          !safe(member.tenant_id, tenantPattern) || (user.tenantId && user.tenantId !== member.tenant_id)) {
        fail('VPAY_MEMBER_UNAVAILABLE');
      }
      return Object.freeze({ userId: member.id, tenantId: member.tenant_id, username: member.username });
    });
  }

  const store = {
    async reserve(intent) {
      if (!intent || !safe(intent.id, idPattern) || !safe(intent.userId, idPattern) ||
          !safe(intent.tenantId, tenantPattern) || !safe(intent.requestKey, requestPattern) ||
          !safe(intent.fingerprint, fingerprintPattern) || !safe(intent.tradeCode, tradeCodePattern) ||
          intent.currency !== 'MYR' || !validTime(intent.createdAt) ||
          !/^\d{1,8}$/.test(String(intent.amountMinor)) || BigInt(intent.amountMinor) < 1n ||
          BigInt(intent.amountMinor) > 10_000_000n) fail('VPAY_INVALID_ORDER');
      return transaction(async () => {
        if (!await lockMember(intent.userId)) fail('VPAY_MEMBER_UNAVAILABLE');
        const member = await trustedMember(intent.userId);
        if (!member || member.role !== 'customer' || !member.approved || member.staff_id ||
            member.tenant_id !== intent.tenantId) fail('VPAY_MEMBER_UNAVAILABLE');
        const inserted = await sql.prepare(`INSERT INTO portal_payment_orders(
          id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,
          settlement_status,review_required,created_at,provider,create_outcome,create_fingerprint,trade_code
        ) VALUES (?,?,?,?,?,?,?,'MYR','created',0,?,'vpay','not_sent',?,?)
        ON CONFLICT(user_id,request_key) DO NOTHING`).run(
          intent.id, member.tenant_id, member.id, intent.requestKey, merchantId, environment,
          Number(intent.amountMinor), intent.createdAt, intent.fingerprint, intent.tradeCode,
        );
        const row = await sql.prepare('SELECT * FROM portal_payment_orders WHERE user_id=? AND request_key=?').get(member.id, intent.requestKey);
        if (!row || row.provider !== PROVIDER || row.merchant_id !== merchantId || row.environment !== environment ||
            row.tenant_id !== member.tenant_id || row.currency !== 'MYR' ||
            BigInt(row.amount_minor) !== BigInt(intent.amountMinor) ||
            row.create_fingerprint !== intent.fingerprint || row.trade_code !== intent.tradeCode) {
          fail('VPAY_IDEMPOTENCY_CONFLICT');
        }
        return { order: await project(row), created: inserted.changes === 1 };
      });
    },

    async claimCreate(orderId, { fingerprint, attemptedAt } = {}) {
      if (!safe(orderId, idPattern) || !safe(fingerprint, fingerprintPattern) || !validTime(attemptedAt)) fail('VPAY_INVALID_ORDER');
      return transaction(async () => {
        const changed = await sql.prepare(`UPDATE portal_payment_orders SET create_outcome='in_flight',create_attempted_at=?
          WHERE id=? AND provider='vpay' AND merchant_id=? AND environment=? AND create_outcome='not_sent'
          AND settlement_status='created' AND review_required=0 AND create_fingerprint=?`).run(
          attemptedAt, orderId, merchantId, environment, fingerprint,
        );
        if (changed.changes === 1) {
          await sql.prepare(`INSERT INTO portal_vpay_attempts(
            id,order_id,operation,attempt_key,outcome,started_at
          ) VALUES (?,?,'create',?,'in_flight',?)`).run(idFactory(), orderId, `create:${fingerprint}`, attemptedAt);
        }
        const row = await rowById(orderId);
        if (!row || row.create_fingerprint !== fingerprint) fail('VPAY_IDEMPOTENCY_CONFLICT');
        return { claimed: changed.changes === 1, order: await project(row) };
      });
    },

    async markCreated(orderId, result) {
      if (!safe(orderId, idPattern) || !result || !safe(result.tradeNo, tradeNoPattern) ||
          !validTime(result.updatedAt) || typeof result.checkoutUrl !== 'string' || result.checkoutUrl.length > 2048 ||
          typeof result.expiresAtRaw !== 'string' || result.expiresAtRaw.length < 1 || result.expiresAtRaw.length > 80) {
        fail('VPAY_CREATE_RESULT_INVALID');
      }
      let url;
      try { url = new URL(result.checkoutUrl); } catch { fail('VPAY_CREATE_RESULT_INVALID'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('VPAY_CREATE_RESULT_INVALID');
      return transaction(async () => {
        const attempt = await sql.prepare(`SELECT * FROM portal_vpay_attempts WHERE order_id=? AND operation='create'
          AND outcome='in_flight' ORDER BY started_at DESC,id DESC LIMIT 1`).get(orderId);
        if (!attempt) {
          const current = await rowById(orderId);
          if (current?.create_outcome === 'created' && current.trade_no === result.tradeNo &&
              ['pending', 'credited'].includes(current.settlement_status)) return project(current);
          fail('VPAY_CREATE_STATE_CONFLICT');
        }
        const changed = await sql.prepare(`UPDATE portal_payment_orders SET trade_no=?,checkout_url=?,expires_at_raw=?,
          create_outcome='created',settlement_status=CASE WHEN settlement_status='created' THEN 'pending' ELSE settlement_status END
          WHERE id=? AND provider='vpay' AND merchant_id=? AND environment=? AND create_outcome IN ('in_flight','created')
          AND settlement_status IN ('created','pending','credited') AND (trade_no IS NULL OR trade_no=?)`).run(
          result.tradeNo, url.toString(), result.expiresAtRaw, orderId, merchantId, environment, result.tradeNo,
        );
        if (changed.changes !== 1) fail('VPAY_CREATE_STATE_CONFLICT');
        const completed = await sql.prepare(`UPDATE portal_vpay_attempts SET outcome='succeeded',
          result_code='CREATE_CONFIRMED',completed_at=? WHERE id=? AND outcome='in_flight'`).run(result.updatedAt, attempt.id);
        if (completed.changes !== 1) fail('VPAY_CREATE_STATE_CONFLICT');
        return project(await rowById(orderId));
      });
    },

    async markCreateUnknown(orderId, { updatedAt } = {}) {
      if (!safe(orderId, idPattern) || !validTime(updatedAt)) fail('VPAY_CREATE_STATE_CONFLICT');
      return transaction(async () => {
        const attempt = await sql.prepare(`SELECT * FROM portal_vpay_attempts WHERE order_id=? AND operation='create'
          AND outcome='in_flight' ORDER BY started_at DESC,id DESC LIMIT 1`).get(orderId);
        const changed = await sql.prepare(`UPDATE portal_payment_orders SET create_outcome='unknown'
          WHERE id=? AND provider='vpay' AND merchant_id=? AND environment=? AND create_outcome='in_flight'
          AND settlement_status IN ('created','pending')`).run(orderId, merchantId, environment);
        if (changed.changes === 1 && !attempt) fail('VPAY_CREATE_STATE_CONFLICT');
        if (changed.changes === 1) {
          const completed = await sql.prepare(`UPDATE portal_vpay_attempts SET outcome='unknown',
            result_code='VPAY_ORDER_CREATION_PENDING',completed_at=? WHERE id=? AND outcome='in_flight'`).run(updatedAt, attempt.id);
          if (completed.changes !== 1) fail('VPAY_CREATE_STATE_CONFLICT');
        }
        const row = await rowById(orderId);
        if (!row || !['unknown', 'created'].includes(row.create_outcome)) fail('VPAY_CREATE_STATE_CONFLICT');
        return project(row);
      });
    },

    async findById(orderId) {
      if (!safe(orderId, idPattern)) return null;
      return withStorage(async () => project(await rowById(orderId)));
    },

    async recordCallback(orderId, event) {
      if (!safe(orderId, idPattern) || !event || !safe(event.eventId, fingerprintPattern) ||
          !safe(event.tradeNo, tradeNoPattern) || !statusValues.has(event.reportedState) ||
          !['independent_query_required', 'finance_review_required', 'not_payable'].includes(event.action) ||
          event.currency !== 'MYR' || !/^\d{1,8}$/.test(String(event.amountMinor)) || !validTime(event.receivedAt)) {
        fail('VPAY_CALLBACK_MISMATCH');
      }
      return transaction(async () => {
        const locked = await sql.prepare(`UPDATE portal_payment_orders SET id=id WHERE id=? AND provider='vpay'
          AND merchant_id=? AND environment=?`).run(orderId, merchantId, environment);
        if (locked.changes !== 1) fail('VPAY_CALLBACK_MISMATCH');
        let row = await rowById(orderId);
        if (!row || row.create_outcome === 'not_sent' || BigInt(row.amount_minor) !== BigInt(event.amountMinor) ||
            (row.trade_no && row.trade_no !== event.tradeNo)) fail('VPAY_CALLBACK_MISMATCH');
        const creditedConflict = row.settlement_status === 'credited' && event.reportedState !== 'paid';
        const existingReview = Boolean(row.review_required) && row.settlement_status !== 'credited';
        const processingState = creditedConflict || existingReview || event.action === 'finance_review_required'
          ? 'review_required' : row.settlement_status === 'credited' ? 'processed'
          : event.action === 'independent_query_required' ? 'pending_query' : 'rejected';
        const rejectionCode = creditedConflict ? 'VPAY_POST_CREDIT_CALLBACK_CONFLICT'
          : existingReview ? 'VPAY_ORDER_ALREADY_UNDER_REVIEW'
          : processingState === 'review_required' ? 'VPAY_FINANCE_REVIEW_REQUIRED'
          : processingState === 'rejected' ? 'VPAY_CALLBACK_NOT_PAYABLE' : null;
        const callbackId = idFactory();
        const inserted = await sql.prepare(`INSERT INTO portal_vpay_callbacks(
          id,order_id,event_key_hash,provider_trade_no,reported_status,amount_minor,currency,
          processing_state,rejection_code,received_at,processed_at
        ) VALUES (?,?,?,?,?,?,'MYR',?,?,?,?) ON CONFLICT(event_key_hash) DO NOTHING`).run(
          callbackId, orderId, event.eventId, event.tradeNo, event.reportedState, Number(event.amountMinor),
          processingState, rejectionCode, event.receivedAt,
          processingState === 'pending_query' ? null : event.receivedAt,
        );
        const callback = await sql.prepare('SELECT * FROM portal_vpay_callbacks WHERE event_key_hash=?').get(event.eventId);
        if (!callback || callback.order_id !== orderId || callback.provider_trade_no !== event.tradeNo ||
            callback.reported_status !== event.reportedState || BigInt(callback.amount_minor) !== BigInt(event.amountMinor)) {
          fail('VPAY_CALLBACK_CONFLICT');
        }
        if (inserted.changes === 1) {
          if (row.settlement_status !== 'credited') {
            const bound = await sql.prepare(`UPDATE portal_payment_orders SET trade_no=COALESCE(trade_no,?),
              settlement_status=CASE WHEN settlement_status='created' THEN 'pending' ELSE settlement_status END
              WHERE id=? AND provider='vpay' AND merchant_id=? AND environment=?
              AND create_outcome IN ('in_flight','unknown','created') AND (trade_no IS NULL OR trade_no=?)`).run(
              event.tradeNo, orderId, merchantId, environment, event.tradeNo,
            );
            if (bound.changes !== 1) fail('VPAY_CALLBACK_CONFLICT');
          }
          if (processingState === 'review_required') {
            await insertReview(row, rejectionCode, {
              amountMinor: event.amountMinor, currency: 'MYR', state: event.reportedState, tradeNo: event.tradeNo,
            }, event.receivedAt, idFactory);
          }
        }
        row = await rowById(orderId);
        return { stored: inserted.changes === 1, callbackId: callback.id,
          processingState: callback.processing_state, order: await project(row) };
      });
    },

    async claimQuery(orderId, { attemptedAt } = {}) {
      if (!safe(orderId, idPattern) || !validTime(attemptedAt)) fail('VPAY_QUERY_STATE_CONFLICT');
      return transaction(async () => {
        const claimedAt = instant(now);
        const row = await rowById(orderId);
        if (!row) fail('VPAY_ORDER_UNKNOWN');
        if (row.settlement_status === 'credited' || row.review_required || !row.trade_no || row.create_outcome === 'not_sent') {
          return { claimed: false, order: await project(row) };
        }
        const callback = await sql.prepare(`SELECT * FROM portal_vpay_callbacks WHERE order_id=?
          AND processing_state='pending_query' ORDER BY received_at ASC,id ASC LIMIT 1`).get(orderId);
        const active = await latestQueryAttempt(orderId, true);
        let reclaimedExpiredLease = false;
        if (active) {
          if (Number.isFinite(Date.parse(active.lease_expires_at)) && claimedAt.getTime() < Date.parse(active.lease_expires_at)) {
            return { claimed: false, order: await project(row, active) };
          }
          const fenced = await sql.prepare(`UPDATE portal_vpay_attempts SET outcome='unknown',
            result_code='VPAY_QUERY_LEASE_EXPIRED',completed_at=?
            WHERE id=? AND order_id=? AND operation='query' AND outcome='in_flight' AND claim_token=?`).run(
            claimedAt.toISOString(), active.id, orderId, active.claim_token,
          );
          if (fenced.changes !== 1) return { claimed: false, order: await project(row, await latestQueryAttempt(orderId, true)) };
          reclaimedExpiredLease = true;
        }
        const previous = await latestQueryAttempt(orderId);
        const previousTime = previous && Date.parse(previous.completed_at || previous.started_at);
        if (!reclaimedExpiredLease && Number.isFinite(previousTime) && claimedAt.getTime() - previousTime < recoveryDelayMs) {
          return { claimed: false, order: await project(row, previous) };
        }
        // The attempt ID itself is the unguessable fencing token. Persisting it
        // again as claim_token makes this invariant enforceable in every
        // completion UPDATE and explicit in the database audit trail.
        const attemptId = idFactory(), claimToken = attemptId;
        if (!safe(attemptId, /^[A-Za-z0-9_-]{16,100}$/)) fail('VPAY_QUERY_STATE_CONFLICT');
        const leaseExpiresAt = new Date(claimedAt.getTime() + queryLeaseMs).toISOString();
        const inserted = await sql.prepare(`INSERT INTO portal_vpay_attempts(
          id,order_id,callback_id,operation,attempt_key,claim_token,lease_expires_at,outcome,started_at
        ) VALUES (?,?,?,'query',?,?,?,'in_flight',?) ON CONFLICT DO NOTHING`).run(
          attemptId, orderId, callback?.id || null, `query:${attemptId}`, claimToken, leaseExpiresAt, claimedAt.toISOString(),
        );
        const attempt = inserted.changes === 1 ? await sql.prepare('SELECT * FROM portal_vpay_attempts WHERE id=?').get(attemptId)
          : await latestQueryAttempt(orderId, true);
        return { claimed: inserted.changes === 1, order: await project(row, attempt) };
      });
    },

    async finishQuery(orderId, update) {
      if (!safe(orderId, idPattern) || !update || !safe(update.attemptId, idPattern) ||
          (update.claimToken != null && update.claimToken !== update.attemptId) ||
          !['pending', 'failed', 'unknown', 'reversed'].includes(update.queryState) ||
          !safe(update.reason, reasonPattern) || !validTime(update.updatedAt) ||
          (update.tradeNo != null && !safe(update.tradeNo, tradeNoPattern)) ||
          (update.amountMinor != null && !/^\d{1,8}$/.test(String(update.amountMinor)))) {
        fail('VPAY_QUERY_STATE_CONFLICT');
      }
      return transaction(async () => {
        const claimToken = update.attemptId;
        const row = await rowById(orderId);
        if (!row) fail('VPAY_ORDER_UNKNOWN');
        const attempt = await sql.prepare(`SELECT * FROM portal_vpay_attempts WHERE id=? AND order_id=?
          AND operation='query' AND outcome='in_flight' AND claim_token=? AND lease_expires_at>=?`).get(
          update.attemptId, orderId, claimToken, update.updatedAt,
        );
        if (!attempt) fail('VPAY_QUERY_LEASE_LOST');
        if (update.tradeNo && (row.trade_no !== update.tradeNo ||
            (update.amountMinor != null && BigInt(row.amount_minor) !== BigInt(update.amountMinor)))) {
          fail('VPAY_QUERY_STATE_CONFLICT');
        }
        const callback = attempt.callback_id ? await sql.prepare(`SELECT * FROM portal_vpay_callbacks
          WHERE id=? AND order_id=? AND processing_state='pending_query'`).get(attempt.callback_id, orderId) : null;
        let resultCode = update.reason;
        if (callback && ['failed', 'reversed'].includes(update.queryState)) {
          const conflict = callback.reported_status === 'paid';
          resultCode = conflict ? 'VPAY_CALLBACK_QUERY_CONFLICT' : update.reason;
          if (conflict) {
            await insertReview(row, resultCode, {
              amountMinor: row.amount_minor, currency: 'MYR', state: update.queryState, tradeNo: row.trade_no,
            }, update.updatedAt, idFactory);
          }
          await sql.prepare(`UPDATE portal_vpay_callbacks SET processing_state=?,rejection_code=?,processed_at=?
            WHERE id=? AND order_id=? AND processing_state='pending_query'`).run(
            conflict ? 'review_required' : 'rejected', resultCode, update.updatedAt, callback.id, orderId,
          );
        }
        const outcome = update.queryState === 'failed' || update.queryState === 'reversed' ? 'failed'
          : update.queryState === 'unknown' ? 'unknown' : 'succeeded';
        const changed = await sql.prepare(`UPDATE portal_vpay_attempts SET outcome=?,result_code=?,
          observed_trade_no=?,observed_status=?,observed_amount_minor=?,completed_at=?
          WHERE id=? AND order_id=? AND outcome='in_flight' AND claim_token=? AND lease_expires_at>=?`).run(
          outcome, resultCode, update.tradeNo || null,
          update.tradeNo ? update.queryState : null, update.amountMinor == null ? null : Number(update.amountMinor),
          update.updatedAt, update.attemptId, orderId, claimToken, update.updatedAt,
        );
        if (changed.changes !== 1) fail('VPAY_QUERY_LEASE_LOST');
        return project(await rowById(orderId), await sql.prepare('SELECT * FROM portal_vpay_attempts WHERE id=?').get(update.attemptId));
      });
    },

    async listRecoveryCandidates({ limit = 25 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('VPAY_QUERY_STATE_CONFLICT');
      return withStorage(async () => {
        const cutoff = new Date(instant(now).getTime() - recoveryDelayMs).toISOString();
        const rows = await sql.prepare(`SELECT o.* FROM portal_payment_orders o
          WHERE o.provider='vpay' AND o.merchant_id=? AND o.environment=? AND o.review_required=0
          AND o.settlement_status IN ('created','pending') AND o.create_outcome IN ('in_flight','unknown','created')
          AND o.trade_no IS NOT NULL AND NOT EXISTS(
            SELECT 1 FROM portal_vpay_attempts a WHERE a.order_id=o.id AND a.operation='query' AND a.outcome='in_flight'
          ) AND NOT EXISTS(
            SELECT 1 FROM portal_vpay_attempts a WHERE a.order_id=o.id AND a.operation='query'
            AND COALESCE(a.completed_at,a.started_at)>=?
          ) ORDER BY o.created_at ASC,o.id ASC LIMIT ?`).all(merchantId, environment, cutoff, limit);
        return Promise.all(rows.map(row => project(row, null)));
      });
    },
  };

  const settlement = {
    async commitConfirmed({ orderId, attemptId, claimToken, confirmation, committedAt } = {}) {
      if (!safe(orderId, idPattern) || !safe(attemptId, idPattern) ||
          (claimToken != null && claimToken !== attemptId) || !confirmation ||
          confirmation.provider !== PROVIDER || confirmation.source !== 'gateway_query' ||
          confirmation.gatewayAuthenticated !== true || confirmation.providerState !== 'paid' ||
          confirmation.currency !== 'MYR' || !safe(confirmation.tradeNo, tradeNoPattern) ||
          !/^\d{1,8}$/.test(String(confirmation.amountMinor)) || !validTime(committedAt)) {
        fail('VPAY_SETTLEMENT_CONFLICT');
      }
      return transaction(async () => {
        claimToken = attemptId;
        let row = await rowById(orderId);
        if (!row || row.trade_no !== confirmation.tradeNo ||
            BigInt(row.amount_minor) !== BigInt(confirmation.amountMinor)) fail('VPAY_SETTLEMENT_CONFLICT');
        if (row.settlement_status === 'credited') {
          if (!await exactJournal(row)) {
            await insertReview(row, 'VPAY_LEDGER_INCONSISTENT', {
              amountMinor: row.amount_minor, currency: 'MYR', state: 'paid', tradeNo: row.trade_no,
            }, committedAt, idFactory);
            return { reviewRequired: true, order: await project(await rowById(orderId)) };
          }
          return { alreadyCredited: true, order: await project(row) };
        }
        const attempt = await sql.prepare(`SELECT * FROM portal_vpay_attempts WHERE id=? AND order_id=?
          AND operation='query' AND outcome='in_flight' AND claim_token=? AND lease_expires_at>=?`).get(
          attemptId, orderId, claimToken, committedAt,
        );
        if (!attempt) fail('VPAY_QUERY_LEASE_LOST');
        const callback = attempt.callback_id ? await sql.prepare(`SELECT * FROM portal_vpay_callbacks WHERE id=?
          AND order_id=? AND processing_state='pending_query'`).get(attempt.callback_id, orderId) : null;
        if (attempt.callback_id && (!callback || callback.provider_trade_no !== confirmation.tradeNo ||
            BigInt(callback.amount_minor) !== BigInt(row.amount_minor))) fail('VPAY_SETTLEMENT_CONFLICT');
        if (!await lockMember(row.user_id)) fail('VPAY_SETTLEMENT_CONFLICT');
        const member = await trustedMember(row.user_id);
        if (!member || member.role !== 'customer' || !member.approved || member.staff_id ||
            member.tenant_id !== row.tenant_id) {
          await insertReview(row, 'VPAY_MEMBERSHIP_CHANGED', {
            amountMinor: confirmation.amountMinor, currency: 'MYR', state: 'paid', tradeNo: confirmation.tradeNo,
          }, committedAt, idFactory);
          if (callback) await sql.prepare(`UPDATE portal_vpay_callbacks SET processing_state='review_required',
            rejection_code='VPAY_MEMBERSHIP_CHANGED',processed_at=? WHERE id=? AND processing_state='pending_query'`).run(
            committedAt, callback.id,
          );
          await sql.prepare(`UPDATE portal_vpay_attempts SET outcome='failed',result_code='VPAY_MEMBERSHIP_CHANGED',
            observed_trade_no=?,observed_status='paid',observed_amount_minor=?,completed_at=?
            WHERE id=? AND outcome='in_flight' AND claim_token=?`).run(
            confirmation.tradeNo, Number(row.amount_minor), committedAt, attempt.id, claimToken,
          );
          return { reviewRequired: true, order: await project(await rowById(orderId)) };
        }
        const changed = await sql.prepare(`UPDATE portal_payment_orders SET settlement_status='credited',
          trade_no=?,create_outcome='created',verified_at=?,credited_at=?
          WHERE id=? AND provider='vpay' AND merchant_id=? AND environment=? AND review_required=0
          AND settlement_status IN ('created','pending') AND trade_no=?`).run(
          confirmation.tradeNo, committedAt, committedAt, orderId, merchantId, environment, confirmation.tradeNo,
        );
        if (changed.changes !== 1) fail('VPAY_SETTLEMENT_CONFLICT');
        await sql.prepare(`INSERT INTO portal_wallet_journal(
          id,order_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at
        ) VALUES (?,?,?,?,?,'MYR',?,?,?)`).run(
          idFactory(), row.id, row.tenant_id, row.user_id, environment,
          Number(row.amount_minor), -Number(row.amount_minor), committedAt,
        );
        const completed = await sql.prepare(`UPDATE portal_vpay_attempts SET outcome='succeeded',
          result_code='QUERY_CONFIRMED',observed_trade_no=?,observed_status='paid',observed_amount_minor=?,completed_at=?
          WHERE id=? AND order_id=? AND outcome='in_flight' AND claim_token=? AND lease_expires_at>=?`).run(
          confirmation.tradeNo, Number(row.amount_minor), committedAt,
          attempt.id, orderId, claimToken, committedAt,
        );
        if (completed.changes !== 1) fail('VPAY_QUERY_LEASE_LOST');
        if (callback) {
          const callbacks = await sql.prepare(`UPDATE portal_vpay_callbacks SET processing_state='processed',processed_at=?
            WHERE order_id=? AND provider_trade_no=? AND amount_minor=? AND processing_state='pending_query'`).run(
            committedAt, orderId, confirmation.tradeNo, Number(row.amount_minor),
          );
          if (callbacks.changes < 1) fail('VPAY_SETTLEMENT_CONFLICT');
        }
        if (row.create_outcome === 'in_flight') {
          await sql.prepare(`UPDATE portal_vpay_attempts SET outcome='succeeded',
            result_code='CREATE_RECOVERED_BY_QUERY',completed_at=?
            WHERE order_id=? AND operation='create' AND outcome='in_flight'`).run(committedAt, orderId);
        }
        await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(
          idFactory(), row.tenant_id, 'system:vpay', `VPay 充值独立查单并入账：${row.id}`, committedAt,
        );
        row = await rowById(orderId);
        return { credited: true, order: await project(row) };
      });
    },
  };

  return Object.freeze({ store: Object.freeze(store), settlement: Object.freeze(settlement), resolveMember });
}
