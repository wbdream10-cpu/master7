import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

delete process.env.PORTAL_POSTGRES_URL;
delete process.env.RENDER;
process.env.NODE_ENV = 'test';
const postgres = process.argv.includes('--postgres');
const directory = mkdtempSync(join(tmpdir(), 'master7-vpay-store-'));
process.env.PORTAL_DATABASE = join(directory, 'vpay-store.sqlite');
if (postgres) {
  process.env.PORTAL_TEST_POSTGRES = '1';
  process.env.PORTAL_TEST_POSTGRES_PATH = join(directory, 'postgres');
} else {
  delete process.env.PORTAL_TEST_POSTGRES;
  delete process.env.PORTAL_TEST_POSTGRES_PATH;
}
globalThis.fetch = () => { throw Error('Unexpected network access in VPay store tests'); };

const { sql, withStorage } = await import('./runtime.mjs');
const { createVPayStore } = await import('./vpay-store.mjs');
const table = name => postgres ? `portal_private.${name}` : name;
const fixedTime = '2026-10-24T00:00:00.000Z';
const members = {
  alice: { userId: 'vpay_member_alice', email: 'vpay-alice@example.test', role: 'customer', tenantId: 'alpha' },
  bob: { userId: 'vpay_member_bob', email: 'vpay-bob@example.test', role: 'customer', tenantId: 'alpha' },
};

await withStorage(async () => {
  for (const [id, name] of [['alpha', 'Alpha'], ['beta', 'Beta']]) {
    await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run(id, name, fixedTime);
  }
  for (const [key, user] of Object.entries(members)) {
    await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(
      user.userId, `vpay_${key}`, user.email, 'synthetic-hash', 'customer', 1, 'synthetic-recovery', fixedTime,
    );
    await sql.prepare('INSERT INTO members VALUES (?,?,?)').run(user.email, 'alpha', fixedTime);
  }
});

let entitySequence = 0;
let orderSequence = 0;
let requestSequence = 0;
let clock = new Date(fixedTime);
const fingerprint = value => createHash('sha256').update(value).digest('hex');
const nextId = () => `vpay_entity_${String(++entitySequence).padStart(8, '0')}`;
const runtime = () => createVPayStore({
  merchantId: '3647', environment: 'uat', now: () => new Date(clock), idFactory: nextId, queryLeaseMs: 10_000,
});
const count = async (name, where = '', values = []) => withStorage(async () => Number((await sql
  .prepare(`SELECT count(*) AS count FROM ${table(name)}${where}`).get(...values)).count));
const one = (name, where, values = []) => withStorage(() => sql
  .prepare(`SELECT * FROM ${table(name)} WHERE ${where}`).get(...values));
const all = (name, where = '1=1', values = []) => withStorage(() => sql
  .prepare(`SELECT * FROM ${table(name)} WHERE ${where}`).all(...values));
const expectCode = (action, code) => assert.rejects(action, error => error?.message === code);

async function reserve(store, user = members.alice, overrides = {}) {
  const identity = await store.resolveMember(user);
  const id = overrides.id || `vpay_order_${++orderSequence}`;
  const requestKey = overrides.requestKey || `vpay_request_${String(++requestSequence).padStart(8, '0')}`;
  const intent = {
    id, userId: identity.userId, tenantId: identity.tenantId, requestKey,
    amountMinor: '1000', currency: 'MYR', tradeCode: '2',
    fingerprint: fingerprint(`${id}:1000:2`), createdAt: fixedTime, ...overrides,
  };
  return { ...(await store.store.reserve(intent)), intent };
}

async function createOrder(store, user = members.alice, overrides = {}) {
  const result = await reserve(store, user, overrides);
  assert.equal((await store.store.claimCreate(result.order.id, {
    fingerprint: result.intent.fingerprint, attemptedAt: fixedTime,
  })).claimed, true);
  const tradeNo = overrides.tradeNo || `trade_${result.order.id}`;
  const order = await store.store.markCreated(result.order.id, {
    tradeNo, checkoutUrl: `https://payment.example.test/pay/${tradeNo}`,
    expiresAtRaw: '2026-10-24 00:02:00', updatedAt: fixedTime,
  });
  return { order, intent: result.intent };
}

const callback = (order, overrides = {}) => ({
  eventId: fingerprint(`callback:${order.id}:${overrides.reportedState || 'paid'}`),
  tradeNo: order.tradeNo, reportedState: 'paid', amountMinor: order.amountMinor,
  currency: 'MYR', action: 'independent_query_required', receivedAt: fixedTime, ...overrides,
});
const confirmation = order => ({
  provider: 'vpay', source: 'gateway_query', gatewayAuthenticated: true,
  providerState: 'paid', tradeNo: order.tradeNo, amountMinor: order.amountMinor, currency: 'MYR',
});

test.beforeEach(async () => {
  entitySequence = 0;
  clock = new Date(fixedTime);
  await withStorage(async () => {
    for (const name of ['portal_vpay_attempts', 'portal_vpay_callbacks', 'portal_wallet_journal',
      'portal_payment_reviews', 'portal_payment_orders', 'audit', 'portal_staff']) {
      await sql.prepare(`DELETE FROM ${table(name)}`).run();
    }
    for (const user of Object.values(members)) {
      await sql.prepare(`UPDATE ${table('portal_users')} SET role='customer',approved=1 WHERE id=?`).run(user.userId);
      await sql.prepare(`UPDATE ${table('members')} SET tenant_id='alpha' WHERE email=?`).run(user.email);
    }
  });
});

test('reservation requires an explicit current membership and stays idempotent', async () => {
  const service = runtime(), first = await reserve(service), retry = await service.store.reserve(first.intent);
  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(retry.order.id, first.order.id);
  assert.equal(await count('portal_payment_orders'), 1);
  await expectCode(() => service.store.reserve({ ...first.intent, amountMinor: '1001' }), 'VPAY_IDEMPOTENCY_CONFLICT');

  await withStorage(() => sql.prepare(`DELETE FROM ${table('members')} WHERE email=?`).run(members.alice.email));
  try {
    await expectCode(() => service.resolveMember({ ...members.alice, tenantId: 'main' }), 'VPAY_MEMBER_UNAVAILABLE');
    await expectCode(() => reserve(service, { ...members.alice, tenantId: 'main' }), 'VPAY_MEMBER_UNAVAILABLE');
    assert.equal(await count('portal_payment_orders'), 1);
  } finally {
    await withStorage(() => sql.prepare(`INSERT INTO ${table('members')}(email,tenant_id,created_at) VALUES (?,?,?)`).run(
      members.alice.email, 'alpha', fixedTime,
    ));
  }
});

test('callback inbox stores only an idempotent semantic projection', async () => {
  const service = runtime(), { order } = await createOrder(service), event = callback(order);
  const first = await service.store.recordCallback(order.id, event);
  const retry = await service.store.recordCallback(order.id, event);
  assert.equal(first.stored, true);
  assert.equal(retry.stored, false);
  assert.equal(retry.callbackId, first.callbackId);
  assert.equal(await count('portal_vpay_callbacks'), 1);
  const stored = await one('portal_vpay_callbacks', 'id=?', [first.callbackId]);
  assert.equal(stored.processing_state, 'pending_query');
  assert.equal(stored.provider_trade_no, order.tradeNo);
  for (const forbidden of ['raw', 'signature', 'sign', 'token', 'secret', 'remark', 'authorization']) {
    assert(!Object.keys(stored).some(key => key.toLowerCase().includes(forbidden)));
  }
  await expectCode(() => service.store.recordCallback(order.id, { ...event, amountMinor: '1001' }), 'VPAY_CALLBACK_MISMATCH');
});

test('one lease holder independently confirms and atomically credits exactly once', async () => {
  const service = runtime(), { order } = await createOrder(service);
  await service.store.recordCallback(order.id, callback(order));
  const claims = await Promise.all(Array.from({ length: 8 }, () => service.store.claimQuery(order.id, { attemptedAt: fixedTime })));
  assert.equal(claims.filter(item => item.claimed).length, 1);
  const claim = claims.find(item => item.claimed).order;
  const committed = await service.settlement.commitConfirmed({
    orderId: order.id, attemptId: claim.queryAttemptId, claimToken: claim.queryClaimToken,
    confirmation: confirmation(order), committedAt: fixedTime,
  });
  assert.equal(committed.credited, true);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [order.id]), 1);
  assert.equal((await one('portal_vpay_callbacks', 'order_id=?', [order.id])).processing_state, 'processed');
  assert.equal((await one('portal_vpay_attempts', "order_id=? AND operation='query'", [order.id])).outcome, 'succeeded');
  const replay = await service.settlement.commitConfirmed({
    orderId: order.id, attemptId: claim.queryAttemptId, claimToken: claim.queryClaimToken,
    confirmation: confirmation(order), committedAt: fixedTime,
  });
  assert.equal(replay.alreadyCredited, true);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [order.id]), 1);
  assert.equal(await count('audit'), 1);
});

test('an expired query worker is fenced and a new lease recovers the order', async () => {
  const service = runtime(), { order } = await createOrder(service);
  await service.store.recordCallback(order.id, callback(order));
  const stale = (await service.store.claimQuery(order.id, { attemptedAt: fixedTime })).order;
  clock = new Date('2026-10-24T00:00:11.000Z');
  assert((await service.store.listRecoveryCandidates()).some(item => item.id === order.id),
    'an expired in-flight lease must return to the recovery queue');
  const fresh = await service.store.claimQuery(order.id, { attemptedAt: clock.toISOString() });
  assert.equal(fresh.claimed, true);
  assert.notEqual(fresh.order.queryAttemptId, stale.queryAttemptId);
  assert.equal((await one('portal_vpay_attempts', 'id=?', [stale.queryAttemptId])).outcome, 'unknown');
  await expectCode(() => service.settlement.commitConfirmed({
    orderId: order.id, attemptId: stale.queryAttemptId, claimToken: stale.queryClaimToken,
    confirmation: confirmation(order), committedAt: clock.toISOString(),
  }), 'VPAY_QUERY_LEASE_LOST');
  const credited = await service.settlement.commitConfirmed({
    orderId: order.id, attemptId: fresh.order.queryAttemptId, claimToken: fresh.order.queryClaimToken,
    confirmation: confirmation(order), committedAt: clock.toISOString(),
  });
  assert.equal(credited.credited, true);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [order.id]), 1);
});

test('pending orders with a known provider reference are recoverable without a callback', async () => {
  const service = runtime(), { order } = await createOrder(service);
  const candidates = await service.store.listRecoveryCandidates();
  assert.deepEqual(candidates.map(item => item.id), [order.id]);
  const claim = await service.store.claimQuery(order.id, { attemptedAt: fixedTime });
  assert.equal(claim.claimed, true);
  assert.equal(claim.order.callbackId, null);
  // A paid callback can arrive after the recovery worker owns its query lease.
  // The eventual atomic commit must close that callback instead of leaving it pending forever.
  await service.store.recordCallback(order.id, callback(order));
  const done = await service.settlement.commitConfirmed({
    orderId: order.id, attemptId: claim.order.queryAttemptId, claimToken: claim.order.queryClaimToken,
    confirmation: confirmation(order), committedAt: fixedTime,
  });
  assert.equal(done.credited, true);
  assert.equal((await one('portal_vpay_callbacks', 'order_id=?', [order.id])).processing_state, 'processed');

  const unknown = await reserve(service, members.bob);
  await service.store.claimCreate(unknown.order.id, { fingerprint: unknown.intent.fingerprint, attemptedAt: fixedTime });
  await service.store.markCreateUnknown(unknown.order.id, { updatedAt: fixedTime });
  assert.equal((await service.store.findById(unknown.order.id)).tradeNo, null);
  assert(!((await service.store.listRecoveryCandidates()).some(item => item.id === unknown.order.id)));
  assert.equal((await service.store.claimQuery(unknown.order.id, { attemptedAt: fixedTime })).claimed, false);
});

test('completed pending queries observe the recovery delay and cannot hot loop', async () => {
  const service = runtime(), { order } = await createOrder(service);
  const claim = (await service.store.claimQuery(order.id, { attemptedAt: fixedTime })).order;
  await service.store.finishQuery(order.id, {
    attemptId: claim.queryAttemptId, queryState: 'pending', reason: 'VPAY_QUERY_NOT_PAID',
    tradeNo: order.tradeNo, amountMinor: order.amountMinor, updatedAt: fixedTime,
  });
  assert(!((await service.store.listRecoveryCandidates()).some(item => item.id === order.id)));
  assert.equal((await service.store.claimQuery(order.id, { attemptedAt: fixedTime })).claimed, false);
  clock = new Date('2026-10-24T00:01:01.000Z');
  assert((await service.store.listRecoveryCandidates()).some(item => item.id === order.id));
  assert.equal((await service.store.claimQuery(order.id, { attemptedAt: clock.toISOString() })).claimed, true);
});

test('membership changes are held for review before wallet credit', async () => {
  const service = runtime(), { order } = await createOrder(service);
  await service.store.recordCallback(order.id, callback(order));
  const claim = (await service.store.claimQuery(order.id, { attemptedAt: fixedTime })).order;
  await withStorage(() => sql.prepare(`UPDATE ${table('members')} SET tenant_id='beta' WHERE email=?`).run(members.alice.email));
  const result = await service.settlement.commitConfirmed({
    orderId: order.id, attemptId: claim.queryAttemptId, claimToken: claim.queryClaimToken,
    confirmation: confirmation(order), committedAt: fixedTime,
  });
  assert.equal(result.reviewRequired, true);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [order.id]), 0);
  assert.equal(Number((await one('portal_payment_orders', 'id=?', [order.id])).review_required), 1);
  assert.equal((await one('portal_vpay_callbacks', 'order_id=?', [order.id])).processing_state, 'review_required');
  assert.equal((await one('portal_payment_reviews', 'order_id=?', [order.id])).reason, 'VPAY_MEMBERSHIP_CHANGED');
});

test('paid callback versus failed independent query creates a durable finance review', async () => {
  const service = runtime(), { order } = await createOrder(service);
  await service.store.recordCallback(order.id, callback(order));
  const claim = (await service.store.claimQuery(order.id, { attemptedAt: fixedTime })).order;
  const finished = await service.store.finishQuery(order.id, {
    attemptId: claim.queryAttemptId, claimToken: claim.queryClaimToken,
    queryState: 'failed', reason: 'VPAY_QUERY_NOT_PAID', tradeNo: order.tradeNo,
    amountMinor: order.amountMinor, updatedAt: fixedTime,
  });
  assert.equal(finished.reviewRequired, true);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [order.id]), 0);
  assert.equal((await one('portal_vpay_callbacks', 'order_id=?', [order.id])).processing_state, 'review_required');
  assert.equal((await one('portal_payment_reviews', 'order_id=?', [order.id])).reason, 'VPAY_CALLBACK_QUERY_CONFLICT');
});

test('audit failure rolls back order, wallet, callback, attempt, and audit together', async () => {
  const service = runtime(), { order } = await createOrder(service);
  await service.store.recordCallback(order.id, callback(order));
  const claim = (await service.store.claimQuery(order.id, { attemptedAt: fixedTime })).order;
  const originalPrepare = sql.prepare;
  sql.prepare = function failAudit(source) {
    if (source.startsWith('INSERT INTO audit')) throw Error('synthetic audit failure');
    return originalPrepare.call(sql, source);
  };
  try {
    await assert.rejects(() => service.settlement.commitConfirmed({
      orderId: order.id, attemptId: claim.queryAttemptId, claimToken: claim.queryClaimToken,
      confirmation: confirmation(order), committedAt: fixedTime,
    }), /synthetic audit failure/);
  } finally {
    sql.prepare = originalPrepare;
  }
  assert.equal((await one('portal_payment_orders', 'id=?', [order.id])).settlement_status, 'pending');
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [order.id]), 0);
  assert.equal((await one('portal_vpay_callbacks', 'order_id=?', [order.id])).processing_state, 'pending_query');
  assert.equal((await one('portal_vpay_attempts', 'id=?', [claim.queryAttemptId])).outcome, 'in_flight');
  assert.equal(await count('audit'), 0);
});

test('schema and source exclude raw callbacks and credential storage', async () => {
  const columns = postgres
    ? await withStorage(() => sql.prepare(`SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema='portal_private' AND table_name IN ('portal_vpay_callbacks','portal_vpay_attempts')`).all())
    : await withStorage(() => sql.prepare(`SELECT name FROM pragma_table_info('portal_vpay_callbacks')
        UNION ALL SELECT name FROM pragma_table_info('portal_vpay_attempts')`).all());
  const names = columns.map(column => column.name.toLowerCase());
  for (const forbidden of ['raw', 'signature', 'api_key', 'secret', 'remark', 'authorization', 'bearer']) {
    assert(!names.some(name => name.includes(forbidden)), `forbidden durable field: ${forbidden}`);
  }
  assert.equal(await count('portal_vpay_callbacks'), 0);
  assert.equal(await count('portal_vpay_attempts'), 0);
});

test.after(async () => {
  await sql.close();
  rmSync(directory, { recursive: true, force: true });
});
