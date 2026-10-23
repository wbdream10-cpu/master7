import { createHash, randomUUID } from 'node:crypto';
import { sql, withStorage } from './runtime.mjs';

const PROVIDER = 'gspay_myr';
const MERCHANT = 'gspay_myr_gateway';
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const tenantPattern = /^[A-Za-z0-9_-]{1,60}$/;
const playerPattern = /^[a-z0-9_-]{3,40}$/;
const fingerprintPattern = /^[0-9a-f]{64}$/;
const paymentIdPattern = /^[1-9]\d{0,39}$/;
const reasonPattern = /^[A-Z0-9_]{3,64}$/;
const QUERY_LEASE_MS = 120_000;

const fail = code => { throw new Error(code); };
const safe = (value, pattern) => typeof value === 'string' && pattern.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const decimal = value => {
  const minor = BigInt(value);
  return `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;
};
const minor = value => {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,5})\.\d{2}$/.test(value)) fail('GSPAY_STORE_INVALID_AMOUNT');
  const [whole, cents] = value.split('.');
  const result = BigInt(whole) * 100n + BigInt(cents);
  if (result < 1n || result > 10_000_000n) fail('GSPAY_STORE_INVALID_AMOUNT');
  return result;
};
const validTime = value => typeof value === 'string' && value.length >= 20 && value.length <= 40 && Number.isFinite(Date.parse(value));
const clone = value => value ? { ...value } : value;
const clockInstant = clock => {
  const value = clock();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail('GSPAY_QUERY_STATE_CONFLICT');
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
  // Writing the referenced key takes PostgreSQL's strong FOR UPDATE row lock,
  // including against a concurrent portal_staff foreign-key insertion. Lock
  // the existing membership row as well before reading the combined identity.
  const locked = await sql.prepare('UPDATE portal_users SET id=id WHERE id=?').run(userId);
  if (locked.changes !== 1) return false;
  await sql.prepare(`UPDATE members SET email=email
    WHERE email=(SELECT email FROM portal_users WHERE id=?)`).run(userId);
  return true;
}

async function rowById(id) {
  return sql.prepare(`SELECT o.*,u.username AS current_username FROM portal_payment_orders o
    JOIN portal_users u ON u.id=o.user_id WHERE o.id=? AND o.provider='gspay_myr'`).get(id);
}

async function latestQueryAttempt(orderId, { inFlight = false } = {}) {
  return sql.prepare(`SELECT * FROM portal_gspay_attempts WHERE order_id=? AND operation='query'
    ${inFlight ? "AND outcome='in_flight'" : ''} ORDER BY started_at DESC,id DESC LIMIT 1`).get(orderId);
}

function queryState(attempt) {
  if (!attempt) return 'idle';
  if (attempt.outcome === 'in_flight') return 'in_flight';
  if (attempt.observed_status === 'failed') return 'failed';
  if (attempt.observed_status === 'paid') return 'confirmed';
  return 'pending';
}

async function project(row, attempt = undefined) {
  if (!row) return null;
  const currentAttempt = attempt === undefined ? await latestQueryAttempt(row.id) : attempt;
  return Object.freeze({
    id: row.id,
    transactionId: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    requestKey: row.request_key,
    playerUsername: row.provider_player_username,
    amountMinor: String(row.amount_minor),
    currency: row.currency,
    fingerprint: row.create_fingerprint,
    provider: row.provider,
    environment: row.environment,
    createState: row.create_outcome,
    settlementStatus: row.settlement_status,
    reviewRequired: Boolean(row.review_required),
    paymentId: row.trade_no || null,
    payUrl: row.checkout_url || null,
    expiresAtRaw: row.expires_at_raw || null,
    payableAmount: row.provider_amount_minor == null ? null : decimal(row.provider_amount_minor),
    queryState: queryState(currentAttempt),
    queryAttemptId: currentAttempt?.outcome === 'in_flight' ? currentAttempt.id : null,
    callbackId: currentAttempt?.outcome === 'in_flight' ? currentAttempt.callback_id : null,
  });
}

async function exactJournal(row) {
  const journal = await sql.prepare('SELECT * FROM portal_wallet_journal WHERE order_id=?').get(row.id);
  return Boolean(journal && journal.tenant_id === row.tenant_id && journal.user_id === row.user_id &&
    journal.environment === row.environment && journal.currency === 'MYR' &&
    BigInt(journal.member_minor) === BigInt(row.amount_minor) &&
    BigInt(journal.clearing_minor) === -BigInt(row.amount_minor));
}

async function insertReview(row, reason, evidence, at, idFactory) {
  if (!safe(reason, reasonPattern)) fail('GSPAY_REVIEW_REASON_INVALID');
  const observed = {
    amountMinor: evidence?.amountMinor == null ? null : String(evidence.amountMinor),
    currency: evidence?.currency === 'MYR' ? 'MYR' : null,
    state: typeof evidence?.state === 'string' && /^[a-z0-9_]{3,40}$/.test(evidence.state) ? evidence.state : null,
    paymentId: typeof evidence?.paymentId === 'string' && paymentIdPattern.test(evidence.paymentId) ? evidence.paymentId : null,
  };
  const evidenceHash = hash({ orderId: row.id, reason, ...observed });
  await sql.prepare(`INSERT INTO portal_payment_reviews(
    id,order_id,tenant_id,reason,evidence_hash,created_at,observed_minor,observed_currency,observed_state,observed_trade_no
  ) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id,reason,evidence_hash) DO NOTHING`).run(
    idFactory(), row.id, row.tenant_id, reason, evidenceHash, at,
    observed.amountMinor, observed.currency, observed.state, observed.paymentId,
  );
  await sql.prepare("UPDATE portal_payment_orders SET review_required=1 WHERE id=? AND provider='gspay_myr'").run(row.id);
}

/**
 * Durable portal-side persistence for the framework-independent GSPAY core.
 * It contains no supplier URL or credential and is not imported by server.mjs.
 */
export function createGSPayCheckoutStore({
  environment = 'uat',
  now = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  if (!['uat', 'production'].includes(environment) || typeof now !== 'function' || typeof idFactory !== 'function') {
    throw new TypeError('Invalid GSPAY store configuration');
  }

  async function resolvePlayerUsername(user) {
    if (!user || user.role !== 'customer' || !safe(user.userId, idPattern)) fail('GSPAY_MEMBER_UNAVAILABLE');
    return withStorage(async () => {
      const member = await trustedMember(user.userId);
      if (!member || member.role !== 'customer' || !member.approved || member.staff_id ||
          !safe(member.username, playerPattern) ||
          (user.tenantId && user.tenantId !== member.tenant_id)) fail('GSPAY_MEMBER_UNAVAILABLE');
      return member.username;
    });
  }

  const store = {
    async reserve(intent) {
      if (!intent || !safe(intent.id, idPattern) || !safe(intent.userId, idPattern) ||
          !safe(intent.tenantId, tenantPattern) || !safe(intent.requestKey, idPattern) ||
          !safe(intent.playerUsername, playerPattern) || !safe(intent.fingerprint, fingerprintPattern) ||
          intent.currency !== 'MYR' || !validTime(intent.createdAt) || !/^\d{1,8}$/.test(String(intent.amountMinor)) ||
          BigInt(intent.amountMinor) < 1n || BigInt(intent.amountMinor) > 10_000_000n) fail('GSPAY_INVALID_ORDER');
      return transaction(async () => {
        if (!await lockMember(intent.userId)) fail('GSPAY_MEMBER_UNAVAILABLE');
        const member = await trustedMember(intent.userId);
        if (!member || member.role !== 'customer' || !member.approved || member.staff_id ||
            member.tenant_id !== intent.tenantId || member.username !== intent.playerUsername) fail('GSPAY_MEMBER_UNAVAILABLE');
        const inserted = await sql.prepare(`INSERT INTO portal_payment_orders(
          id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,
          settlement_status,review_required,created_at,provider,create_outcome,create_fingerprint,
          provider_player_username,trade_code
        ) VALUES (?,?,?,?,?,?,?,'MYR','created',0,?,'gspay_myr','not_sent',?,?,'payment')
        ON CONFLICT(user_id,request_key) DO NOTHING`).run(
          intent.id, member.tenant_id, member.id, intent.requestKey, MERCHANT, environment,
          Number(intent.amountMinor), intent.createdAt, intent.fingerprint, member.username,
        );
        const row = await sql.prepare('SELECT o.*,u.username AS current_username FROM portal_payment_orders o JOIN portal_users u ON u.id=o.user_id WHERE o.user_id=? AND o.request_key=?').get(member.id, intent.requestKey);
        if (!row || row.provider !== PROVIDER || row.environment !== environment || row.tenant_id !== member.tenant_id ||
            row.provider_player_username !== member.username || row.currency !== 'MYR' ||
            BigInt(row.amount_minor) !== BigInt(intent.amountMinor) || row.create_fingerprint !== intent.fingerprint ||
            row.trade_code !== 'payment') {
          fail('GSPAY_IDEMPOTENCY_CONFLICT');
        }
        return { order: await project(row), created: inserted.changes === 1 };
      });
    },

    async claimCreate(orderId, { fingerprint, attemptedAt } = {}) {
      if (!safe(orderId, idPattern) || !safe(fingerprint, fingerprintPattern) || !validTime(attemptedAt)) fail('GSPAY_INVALID_ORDER');
      return transaction(async () => {
        const changed = await sql.prepare(`UPDATE portal_payment_orders SET
          create_outcome='in_flight',create_attempted_at=?
          WHERE id=? AND provider='gspay_myr' AND environment=? AND create_outcome='not_sent'
          AND settlement_status='created' AND review_required=0 AND create_fingerprint=? AND trade_code='payment'`).run(
          attemptedAt, orderId, environment, fingerprint,
        );
        if (changed.changes === 1) {
          await sql.prepare(`INSERT INTO portal_gspay_attempts(
            id,order_id,operation,attempt_key,outcome,started_at
          ) VALUES (?,?,'create',?,'in_flight',?)`).run(
            idFactory(), orderId, `create:${fingerprint}`, attemptedAt,
          );
        }
        const row = await rowById(orderId);
        if (!row || row.environment !== environment || row.create_fingerprint !== fingerprint) fail('GSPAY_IDEMPOTENCY_CONFLICT');
        return { claimed: changed.changes === 1, order: await project(row) };
      });
    },

    async markCreated(orderId, result) {
      if (!safe(orderId, idPattern) || !result || !safe(result.paymentId, paymentIdPattern) ||
          result.transactionId !== orderId || !validTime(result.createdAt) ||
          typeof result.payUrl !== 'string' || result.payUrl.length > 2048 ||
          typeof result.expiresAtRaw !== 'string' || result.expiresAtRaw.length < 1 || result.expiresAtRaw.length > 80) {
        fail('GSPAY_CREATE_RESULT_INVALID');
      }
      let payUrl;
      try { payUrl = new URL(result.payUrl); } catch { fail('GSPAY_CREATE_RESULT_INVALID'); }
      if (payUrl.protocol !== 'https:' || payUrl.username || payUrl.password || payUrl.hash) fail('GSPAY_CREATE_RESULT_INVALID');
      const providerMinor = result.payableAmount == null ? null : minor(result.payableAmount);
      return transaction(async () => {
        const attempt = await sql.prepare(`SELECT * FROM portal_gspay_attempts WHERE order_id=? AND operation='create'
          AND outcome='in_flight' ORDER BY started_at DESC,id DESC LIMIT 1`).get(orderId);
        if (!attempt) {
          const current = await rowById(orderId);
          if (current && current.environment === environment && current.create_outcome === 'created' &&
              current.trade_code === 'payment' && current.trade_no === result.paymentId &&
              ['pending', 'credited'].includes(current.settlement_status)) return project(current);
          fail('GSPAY_CREATE_STATE_CONFLICT');
        }
        const changed = await sql.prepare(`UPDATE portal_payment_orders SET
          trade_no=?,checkout_url=?,expires_at_raw=?,provider_amount_minor=?,
          create_outcome='created',trade_code='payment',
          settlement_status=CASE WHEN settlement_status='created' THEN 'pending' ELSE settlement_status END
          WHERE id=? AND provider='gspay_myr' AND environment=? AND create_outcome IN ('in_flight','created')
          AND settlement_status IN ('created','pending','credited')
          AND trade_code='payment' AND (trade_no IS NULL OR trade_no=?)`).run(
          result.paymentId, payUrl.toString(), result.expiresAtRaw,
          providerMinor == null ? null : Number(providerMinor), orderId, environment, result.paymentId,
        );
        if (changed.changes !== 1) fail('GSPAY_CREATE_STATE_CONFLICT');
        const completed = await sql.prepare(`UPDATE portal_gspay_attempts SET outcome='succeeded',
          result_code='CREATE_CONFIRMED',completed_at=? WHERE id=? AND outcome='in_flight'`).run(result.createdAt, attempt.id);
        if (completed.changes !== 1) fail('GSPAY_CREATE_STATE_CONFLICT');
        return project(await rowById(orderId));
      });
    },

    async markCreateUnknown(orderId, update) {
      if (!safe(orderId, idPattern) || !update || update.reason !== 'GSPAY_ORDER_CREATION_PENDING' || !validTime(update.updatedAt)) {
        fail('GSPAY_CREATE_STATE_CONFLICT');
      }
      return transaction(async () => {
        const attempt = await sql.prepare(`SELECT * FROM portal_gspay_attempts WHERE order_id=? AND operation='create'
          AND outcome='in_flight' ORDER BY started_at DESC,id DESC LIMIT 1`).get(orderId);
        const changed = await sql.prepare(`UPDATE portal_payment_orders SET create_outcome='unknown'
          WHERE id=? AND provider='gspay_myr' AND environment=? AND create_outcome='in_flight'
          AND settlement_status IN ('created','pending')`).run(orderId, environment);
        if (changed.changes === 1 && !attempt) fail('GSPAY_CREATE_STATE_CONFLICT');
        if (changed.changes === 1) {
          await sql.prepare(`UPDATE portal_gspay_attempts SET outcome='unknown',result_code=?,completed_at=?
            WHERE id=? AND outcome='in_flight'`).run(update.reason, update.updatedAt, attempt.id);
        }
        const row = await rowById(orderId);
        if (!row || !['unknown', 'created'].includes(row.create_outcome)) fail('GSPAY_CREATE_STATE_CONFLICT');
        return project(row);
      });
    },

    async findByTransactionId(transactionId) {
      if (!safe(transactionId, idPattern)) return null;
      return withStorage(async () => project(await rowById(transactionId)));
    },

    async findById(orderId) {
      if (!safe(orderId, idPattern)) return null;
      return withStorage(async () => project(await rowById(orderId)));
    },

    async recordCallback(orderId, event) {
      if (!safe(orderId, idPattern) || !event || !safe(event.eventId, fingerprintPattern) ||
          !['payment', 'duitnow'].includes(event.channel) || !safe(event.providerId, paymentIdPattern) ||
          event.transactionId !== orderId || event.currency !== 'MYR' || !/^\d{1,8}$/.test(String(event.amountMinor)) ||
          !['pending', 'paid', 'failed', 'pending_or_expired', 'manual_success_review', 'timeout_or_rejected'].includes(event.reportedState) ||
          !['independent_query_required', 'finance_review_required', 'not_payable'].includes(event.action) ||
          !validTime(event.receivedAt)) fail('GSPAY_CALLBACK_MISMATCH');
      return transaction(async () => {
        const locked = await sql.prepare(`UPDATE portal_payment_orders SET id=id
          WHERE id=? AND provider='gspay_myr' AND environment=?`).run(orderId, environment);
        if (locked.changes !== 1) fail('GSPAY_CALLBACK_MISMATCH');
        let row = await rowById(orderId);
        if (!row || row.environment !== environment || row.create_outcome === 'not_sent' ||
            (row.trade_no && row.trade_no !== event.providerId) ||
            (row.trade_code && row.trade_code !== 'payment')) fail('GSPAY_CALLBACK_MISMATCH');
        const expectedCallbackMinor = event.channel === 'duitnow' ? row.provider_amount_minor : row.amount_minor;
        if (expectedCallbackMinor == null || BigInt(expectedCallbackMinor) !== BigInt(event.amountMinor)) fail('GSPAY_CALLBACK_MISMATCH');
        const duitNowQueryUnsupported = event.channel === 'duitnow' && event.action === 'independent_query_required';
        const latePaymentConflict = row.settlement_status === 'credited' && event.channel === 'payment' &&
          (event.action !== 'independent_query_required' || event.reportedState !== 'paid');
        const orderAlreadyUnderReview = Boolean(row.review_required) && row.settlement_status !== 'credited';
        const state = duitNowQueryUnsupported || latePaymentConflict || orderAlreadyUnderReview ? 'review_required'
          : row.settlement_status === 'credited' && event.channel === 'payment' ? 'processed'
          : event.action === 'independent_query_required' ? 'pending_query'
          : event.action === 'finance_review_required' ? 'review_required' : 'rejected';
        const rejection = duitNowQueryUnsupported ? 'GSPAY_DUITNOW_QUERY_UNCONFIRMED'
          : latePaymentConflict ? 'GSPAY_POST_CREDIT_CALLBACK_CONFLICT'
          : orderAlreadyUnderReview ? 'GSPAY_ORDER_ALREADY_UNDER_REVIEW'
          : state === 'review_required' ? 'GSPAY_FINANCE_REVIEW_REQUIRED'
          : state === 'rejected' ? 'GSPAY_CALLBACK_NOT_PAYABLE' : null;
        const callbackId = `gcb_${event.eventId}`;
        const inserted = await sql.prepare(`INSERT INTO portal_gspay_callbacks(
          id,order_id,event_key_hash,channel,provider_payment_id,reported_status,amount_minor,currency,
          processing_state,rejection_code,received_at,processed_at
        ) VALUES (?,?,?,?,?,?,?,'MYR',?,?,?,?) ON CONFLICT(event_key_hash) DO NOTHING`).run(
          callbackId, orderId, event.eventId, event.channel, event.providerId, event.reportedState,
          Number(event.amountMinor), state, rejection, event.receivedAt,
          state === 'pending_query' ? null : event.receivedAt,
        );
        const callback = await sql.prepare('SELECT * FROM portal_gspay_callbacks WHERE event_key_hash=?').get(event.eventId);
        if (!callback || callback.order_id !== orderId || callback.channel !== event.channel ||
            callback.provider_payment_id !== event.providerId || String(callback.amount_minor) !== String(event.amountMinor)) {
          fail('GSPAY_CALLBACK_CONFLICT');
        }
        if (inserted.changes === 1) {
          if (event.channel === 'payment' && row.settlement_status !== 'credited') {
            const bound = await sql.prepare(`UPDATE portal_payment_orders SET trade_no=COALESCE(trade_no,?),
              trade_code='payment',
              settlement_status=CASE WHEN settlement_status='created' THEN 'pending' ELSE settlement_status END
              WHERE id=? AND provider='gspay_myr' AND environment=?
              AND create_outcome IN ('in_flight','unknown','created')
              AND (trade_code IS NULL OR trade_code='payment') AND (trade_no IS NULL OR trade_no=?)`).run(
              event.providerId, orderId, environment, event.providerId,
            );
            if (bound.changes !== 1) fail('GSPAY_CALLBACK_CONFLICT');
          }
          if (state === 'review_required') {
            await insertReview(row, rejection, {
              amountMinor: event.amountMinor, currency: 'MYR', state: event.reportedState, paymentId: event.providerId,
            }, event.receivedAt, idFactory);
          }
        }
        row = await rowById(orderId);
        return { stored: inserted.changes === 1, callbackId: callback.id,
          processingState: callback.processing_state, order: await project(row) };
      });
    },

    async claimQuery(orderId, { attemptedAt } = {}) {
      if (!safe(orderId, idPattern) || !validTime(attemptedAt)) fail('GSPAY_QUERY_STATE_CONFLICT');
      return transaction(async () => {
        const claimedAt = clockInstant(now);
        const row = await rowById(orderId);
        if (!row || row.environment !== environment) fail('GSPAY_ORDER_UNKNOWN');
        if (row.settlement_status === 'credited' || row.review_required) return { claimed: false, order: await project(row) };
        if (row.trade_code !== 'payment') fail('GSPAY_QUERY_STATE_CONFLICT');
        const callback = await sql.prepare(`SELECT * FROM portal_gspay_callbacks WHERE order_id=?
          AND channel='payment' AND processing_state='pending_query'
          ORDER BY received_at ASC,id ASC LIMIT 1`).get(orderId);
        if (!callback) return { claimed: false, order: await project(row) };
        const active = await latestQueryAttempt(orderId, { inFlight: true });
        if (active) {
          const startedAt = Date.parse(active.started_at);
          if (!Number.isFinite(startedAt) || claimedAt.getTime() - startedAt < QUERY_LEASE_MS) {
            return { claimed: false, order: await project(row, active) };
          }
          const expired = await sql.prepare(`UPDATE portal_gspay_attempts SET outcome='unknown',
            result_code='GSPAY_QUERY_LEASE_EXPIRED',completed_at=?
            WHERE id=? AND order_id=? AND operation='query' AND outcome='in_flight'`).run(
            claimedAt.toISOString(), active.id, orderId,
          );
          if (expired.changes !== 1) {
            return { claimed: false, order: await project(row, await latestQueryAttempt(orderId, { inFlight: true })) };
          }
        }
        const attemptId = idFactory();
        const inserted = await sql.prepare(`INSERT INTO portal_gspay_attempts(
          id,order_id,callback_id,operation,attempt_key,outcome,started_at
        ) VALUES (?,?,?,'query',?,'in_flight',?) ON CONFLICT DO NOTHING`).run(
          attemptId, orderId, callback.id, `query:${attemptId}`, claimedAt.toISOString(),
        );
        const attempt = inserted.changes === 1
          ? await sql.prepare('SELECT * FROM portal_gspay_attempts WHERE id=?').get(attemptId)
          : await latestQueryAttempt(orderId, { inFlight: true });
        return { claimed: inserted.changes === 1, order: await project(row, attempt) };
      });
    },

    async finishQuery(orderId, update) {
      if (!safe(orderId, idPattern) || !update || !['pending', 'failed'].includes(update.queryState) ||
          !safe(update.attemptId, idPattern) || !safe(update.reason, reasonPattern) || !validTime(update.updatedAt) ||
          (update.providerId != null && !safe(update.providerId, paymentIdPattern))) fail('GSPAY_QUERY_STATE_CONFLICT');
      return transaction(async () => {
        const locked = await sql.prepare(`UPDATE portal_payment_orders SET id=id
          WHERE id=? AND provider='gspay_myr' AND environment=?`).run(orderId, environment);
        if (locked.changes !== 1) fail('GSPAY_ORDER_UNKNOWN');
        const row = await rowById(orderId);
        if (!row || row.environment !== environment) fail('GSPAY_ORDER_UNKNOWN');
        const attempt = await sql.prepare(`SELECT * FROM portal_gspay_attempts
          WHERE id=? AND order_id=? AND operation='query' AND outcome='in_flight'`).get(update.attemptId, orderId);
        if (attempt) {
          const callback = attempt.callback_id ? await sql.prepare(`SELECT * FROM portal_gspay_callbacks
            WHERE id=? AND order_id=? AND channel='payment' AND processing_state='pending_query'`).get(
            attempt.callback_id, orderId,
          ) : null;
          if (!callback) fail('GSPAY_QUERY_STATE_CONFLICT');
          if (update.providerId && (callback.provider_payment_id !== update.providerId ||
              (row.trade_no && row.trade_no !== update.providerId))) fail('GSPAY_QUERY_STATE_CONFLICT');
          const observed = update.providerId ? update.queryState : null;
          const outcome = !update.providerId ? 'unknown'
            : update.queryState === 'failed' ? 'failed' : 'succeeded';
          let resultCode = update.reason;
          if (update.providerId && update.queryState === 'failed') {
            const paidCallbacks = await sql.prepare(`SELECT count(*) AS count FROM portal_gspay_callbacks
              WHERE order_id=? AND channel='payment' AND provider_payment_id=?
              AND amount_minor=? AND processing_state='pending_query' AND reported_status='paid'`).get(
              orderId, update.providerId, Number(row.amount_minor),
            );
            const contradictory = Number(paidCallbacks.count) > 0;
            resultCode = contradictory ? 'GSPAY_CALLBACK_QUERY_CONFLICT' : update.reason;
            if (contradictory) {
              await insertReview(row, resultCode, {
                amountMinor: row.amount_minor, currency: 'MYR', state: 'failed', paymentId: update.providerId,
              }, update.updatedAt, idFactory);
            }
            const closed = await sql.prepare(`UPDATE portal_gspay_callbacks SET
              processing_state=?,rejection_code=?,processed_at=?
              WHERE order_id=? AND channel='payment' AND provider_payment_id=?
              AND amount_minor=? AND processing_state='pending_query'`).run(
              contradictory ? 'review_required' : 'rejected', resultCode, update.updatedAt,
              orderId, update.providerId, Number(row.amount_minor),
            );
            if (closed.changes < 1) fail('GSPAY_QUERY_STATE_CONFLICT');
          }
          const changed = await sql.prepare(`UPDATE portal_gspay_attempts SET
            outcome=?,result_code=?,observed_provider_payment_id=?,observed_status=?,observed_amount_minor=?,completed_at=?
            WHERE id=? AND outcome='in_flight'`).run(
            outcome, resultCode, update.providerId || null, observed,
            update.providerId ? Number(row.amount_minor) : null, update.updatedAt, attempt.id,
          );
          if (changed.changes !== 1) fail('GSPAY_QUERY_STATE_CONFLICT');
        }
        return project(await rowById(orderId), attempt
          ? await sql.prepare('SELECT * FROM portal_gspay_attempts WHERE id=?').get(attempt.id)
          : await latestQueryAttempt(orderId));
      });
    },
  };

  const settlement = {
    async commitConfirmed({ order, confirmation, committedAt } = {}) {
      if (!order || !confirmation || !safe(order.id, idPattern) || confirmation.transactionId !== order.id ||
          !safe(confirmation.paymentId, paymentIdPattern) || !safe(confirmation.playerUsername, playerPattern) ||
          confirmation.provider !== PROVIDER || confirmation.contract !== 'gspay-myr-query-v1' ||
          confirmation.source !== 'gateway_query' || confirmation.currency !== 'MYR' ||
          confirmation.providerState !== 'paid' || confirmation.settlementStatus !== 'query_confirmed' ||
          confirmation.completed !== true || confirmation.success !== true ||
          confirmation.signatureVerified !== true || confirmation.gatewayAuthenticated !== true ||
          confirmation.fundsProcessed !== false || !/^\d{1,8}$/.test(String(confirmation.amountMinor)) ||
          !validTime(committedAt)) fail('GSPAY_SETTLEMENT_CONFLICT');
      return transaction(async () => {
        let row = await rowById(order.id);
        if (!row || row.environment !== environment || row.provider !== PROVIDER ||
            row.tenant_id !== order.tenantId || row.user_id !== order.userId || row.currency !== 'MYR' ||
            row.trade_code !== 'payment' ||
            row.provider_player_username !== order.playerUsername || confirmation.playerUsername !== row.provider_player_username ||
            BigInt(row.amount_minor) !== BigInt(order.amountMinor) || BigInt(row.amount_minor) !== BigInt(confirmation.amountMinor) ||
            confirmation.amount !== decimal(row.amount_minor) ||
            (row.trade_no && row.trade_no !== confirmation.paymentId)) fail('GSPAY_SETTLEMENT_CONFLICT');
        if (row.settlement_status === 'credited') {
          if (!await exactJournal(row)) {
            await insertReview(row, 'GSPAY_LEDGER_INCONSISTENT', {
              amountMinor: row.amount_minor, currency: 'MYR', state: 'credited', paymentId: row.trade_no,
            }, committedAt, idFactory);
            row = await rowById(row.id);
            return { reviewRequired: true, order: await project(row) };
          }
          return { alreadyCredited: true, order: await project(row) };
        }
        const attempt = order.queryAttemptId
          ? await sql.prepare("SELECT * FROM portal_gspay_attempts WHERE id=? AND order_id=? AND operation='query' AND outcome='in_flight'").get(order.queryAttemptId, row.id)
          : await latestQueryAttempt(row.id, { inFlight: true });
        if (!attempt || !attempt.callback_id) fail('GSPAY_SETTLEMENT_CONFLICT');
        const callback = await sql.prepare(`SELECT * FROM portal_gspay_callbacks WHERE id=? AND order_id=?
          AND channel='payment' AND processing_state='pending_query'`).get(attempt.callback_id, row.id);
        if (!callback || callback.provider_payment_id !== confirmation.paymentId ||
            BigInt(callback.amount_minor) !== BigInt(row.amount_minor)) fail('GSPAY_SETTLEMENT_CONFLICT');
        if (!await lockMember(row.user_id)) fail('GSPAY_SETTLEMENT_CONFLICT');
        const member = await trustedMember(row.user_id);
        if (!member || member.role !== 'customer' || !member.approved || member.staff_id ||
            member.tenant_id !== row.tenant_id || member.username !== row.provider_player_username) {
          await insertReview(row, 'GSPAY_MEMBERSHIP_CHANGED', {
            amountMinor: confirmation.amountMinor, currency: 'MYR', state: 'paid', paymentId: confirmation.paymentId,
          }, committedAt, idFactory);
          await sql.prepare(`UPDATE portal_gspay_callbacks SET processing_state='review_required',
            rejection_code='GSPAY_MEMBERSHIP_CHANGED',processed_at=? WHERE order_id=? AND channel='payment'
            AND provider_payment_id=? AND amount_minor=? AND processing_state='pending_query'`).run(
            committedAt, row.id, confirmation.paymentId, Number(row.amount_minor),
          );
          await sql.prepare(`UPDATE portal_gspay_attempts SET outcome='failed',result_code='GSPAY_MEMBERSHIP_CHANGED',
            completed_at=? WHERE id=? AND outcome='in_flight'`).run(committedAt, attempt.id);
          row = await rowById(row.id);
          return { reviewRequired: true, order: await project(row) };
        }
        const changed = await sql.prepare(`UPDATE portal_payment_orders SET settlement_status='credited',
          trade_no=?,trade_code='payment',create_outcome='created',verified_at=?,credited_at=?
          WHERE id=? AND provider='gspay_myr' AND environment=?
          AND review_required=0 AND settlement_status IN ('created','pending')
          AND provider_player_username=? AND trade_code='payment' AND (trade_no IS NULL OR trade_no=?)`).run(
          confirmation.paymentId, committedAt, committedAt, row.id, environment,
          row.provider_player_username, confirmation.paymentId,
        );
        if (changed.changes !== 1) fail('GSPAY_SETTLEMENT_CONFLICT');
        await sql.prepare(`INSERT INTO portal_wallet_journal(
          id,order_id,tenant_id,user_id,environment,currency,member_minor,clearing_minor,created_at
        ) VALUES (?,?,?,?,?,'MYR',?,?,?)`).run(
          idFactory(), row.id, row.tenant_id, row.user_id, environment,
          Number(row.amount_minor), -Number(row.amount_minor), committedAt,
        );
        const finishedAttempt = await sql.prepare(`UPDATE portal_gspay_attempts SET outcome='succeeded',
          result_code='QUERY_CONFIRMED',observed_provider_payment_id=?,observed_status='paid',
          observed_amount_minor=?,completed_at=? WHERE id=? AND outcome='in_flight'`).run(
          confirmation.paymentId, Number(row.amount_minor), committedAt, attempt.id,
        );
        const finishedCallbacks = await sql.prepare(`UPDATE portal_gspay_callbacks SET processing_state='processed',
          processed_at=? WHERE order_id=? AND channel='payment' AND provider_payment_id=?
          AND amount_minor=? AND processing_state='pending_query'`).run(
          committedAt, row.id, confirmation.paymentId, Number(row.amount_minor),
        );
        if (finishedAttempt.changes !== 1 || finishedCallbacks.changes < 1) fail('GSPAY_SETTLEMENT_CONFLICT');
        if (row.create_outcome === 'in_flight') {
          const recovered = await sql.prepare(`UPDATE portal_gspay_attempts SET outcome='succeeded',
            result_code='CREATE_RECOVERED_BY_QUERY',completed_at=?
            WHERE order_id=? AND operation='create' AND outcome='in_flight'`).run(committedAt, row.id);
          if (recovered.changes !== 1) fail('GSPAY_SETTLEMENT_CONFLICT');
        }
        await sql.prepare('INSERT INTO audit(id,tenant_id,actor,action,created_at) VALUES (?,?,?,?,?)').run(
          idFactory(), row.tenant_id, 'system:gspay', `GSPAY+ MYR 充值独立查单并入账：${row.id}`, committedAt,
        );
        row = await rowById(row.id);
        return { credited: true, order: await project(row) };
      });
    },
  };

  return Object.freeze({ store: Object.freeze(store), settlement: Object.freeze(settlement), resolvePlayerUsername });
}
