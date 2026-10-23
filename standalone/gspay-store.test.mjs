import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GSPAY_CALLBACK_PROJECTION_CONTRACT,
  GSPAY_CREATE_PROJECTION_CONTRACT,
  GSPAY_QUERY_PROJECTION_CONTRACT,
  GSPayCheckoutError,
  createGSPayCheckoutCore,
} from './gspay-checkout-core.mjs';

delete process.env.PORTAL_POSTGRES_URL;
delete process.env.RENDER;
process.env.NODE_ENV = 'test';
const postgres = process.argv.includes('--postgres');
const directory = mkdtempSync(join(tmpdir(), 'master7-gspay-store-'));
process.env.PORTAL_DATABASE = join(directory, 'gspay-store.sqlite');
if (postgres) {
  process.env.PORTAL_TEST_POSTGRES = '1';
  process.env.PORTAL_TEST_POSTGRES_PATH = join(directory, 'postgres');
} else {
  delete process.env.PORTAL_TEST_POSTGRES;
  delete process.env.PORTAL_TEST_POSTGRES_PATH;
}
globalThis.fetch = () => { throw Error('Unexpected network access in GSPAY store tests'); };

const { sql, withStorage } = await import('./runtime.mjs');
const { createGSPayCheckoutStore } = await import('./gspay-store.mjs');
const table = name => (postgres ? `portal_private.${name}` : name);
const fixedTime = '2026-10-24T00:00:00.000Z';
const members = {
  alice: { userId: 'member_alice', email: 'alice@example.test', role: 'customer', tenantId: 'alpha' },
  bob: { userId: 'member_bob', email: 'bob@example.test', role: 'customer', tenantId: 'alpha' },
  carol: { userId: 'member_carol', email: 'carol@example.test', role: 'customer', tenantId: 'alpha' },
};

await withStorage(async () => {
  for (const [id, name] of [['alpha', 'Alpha'], ['beta', 'Beta']]) {
    await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run(id, name, fixedTime);
  }
  for (const [key, user] of Object.entries(members)) {
    await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(
      user.userId, `player_${key}`, user.email, 'synthetic-hash', 'customer', 1, 'synthetic-recovery', fixedTime,
    );
    await sql.prepare('INSERT INTO members VALUES (?,?,?)').run(user.email, 'alpha', fixedTime);
  }
});

let requestSequence = 0;
let orderSequence = 0;
let entitySequence = 0;
const readiness = Object.freeze({
  provider: 'gspay_myr', configured: true, contractVersionConfirmed: true,
  ordersReady: true, callbacksReady: true, queryReady: true, liveReady: true,
});
const gatewayBase = Object.freeze({
  provider: 'gspay_myr', gatewayAuthenticated: true, signatureVerified: true, fundsProcessed: false,
});
const callbackBase = Object.freeze({
  provider: 'gspay_myr', signatureVerified: true, fundsProcessed: false,
});
const callbackContext = Object.freeze({ gatewayAuthenticated: true });
const input = (amount = '10.00') => ({
  amount, currency: 'MYR', requestKey: `synthetic_gspay_request_${++requestSequence}`,
});
const count = async (name, where = '', values = []) => withStorage(async () => Number((await sql
  .prepare(`SELECT count(*) AS count FROM ${table(name)}${where}`).get(...values)).count));
const one = (name, where, values = []) => withStorage(() => sql
  .prepare(`SELECT * FROM ${table(name)} WHERE ${where}`).get(...values));
const all = (name, where = '1=1', values = []) => withStorage(() => sql
  .prepare(`SELECT * FROM ${table(name)} WHERE ${where}`).all(...values));
const expectCode = (action, code) => assert.rejects(action, error =>
  error?.message === code && (!(error instanceof GSPayCheckoutError) || error.code === code));

function harness({
  createError = null,
  payableAmount = null,
  queryState = 'paid',
  queryImpl = null,
  clock = () => new Date(fixedTime),
} = {}) {
  const persistence = createGSPayCheckoutStore({
    environment: 'uat',
    now: clock,
    idFactory: () => `gspay_entity_${++entitySequence}`,
  });
  const calls = { create: 0, query: 0 };
  let currentQueryState = queryState;
  const gateway = {
    status: () => readiness,
    async createPayment(draft) {
      calls.create++;
      if (createError) throw createError;
      return { draft, paymentId: String(9000000000 + calls.create + orderSequence * 10) };
    },
    async queryPayment(expected) {
      calls.query++;
      if (queryImpl) return queryImpl(expected, calls.query);
      const pending = currentQueryState === 'pending';
      const failed = currentQueryState === 'failed';
      return {
        ...gatewayBase,
        contract: GSPAY_QUERY_PROJECTION_CONTRACT,
        source: 'gateway_query',
        transactionId: expected.transactionId,
        paymentId: expected.paymentId,
        playerUsername: expected.playerUsername,
        currency: 'MYR',
        amount: expected.amount,
        amountMinor: expected.amountMinor,
        completed: !pending,
        success: !pending && !failed,
        providerState: pending ? 'pending' : failed ? 'failed' : 'paid',
        settlementStatus: pending || failed ? 'not_payable' : 'query_confirmed',
      };
    },
  };
  const core = createGSPayCheckoutCore({
    ordersEnabled: true,
    callbacksEnabled: true,
    settlementEnabled: true,
    allowedPaymentOrigins: ['https://pay.example.test'],
    inspectCreateResult: (raw, expected) => ({
      ...gatewayBase,
      contract: GSPAY_CREATE_PROJECTION_CONTRACT,
      source: 'gateway_create',
      createSchemaConfirmed: true,
      paymentId: raw.paymentId,
      transactionId: expected.transactionId,
      payUrl: `https://pay.example.test/checkout/${raw.paymentId}`,
      expiresAtRaw: '2026-10-24 00:02:00',
      ...(payableAmount === null ? {} : { payableAmount }),
    }),
    resolvePlayerUsername: persistence.resolvePlayerUsername,
    store: persistence.store,
    settlement: persistence.settlement,
    gateway,
    now: clock,
    idFactory: () => `gspay_order_${++orderSequence}`,
  });
  return {
    ...persistence,
    core,
    gateway,
    calls,
    setQueryState(value) { currentQueryState = value; },
  };
}

async function createOrder(runtime, user = members.alice, data = input()) {
  const result = await runtime.core.submit(user, data);
  assert.equal(result.status, 'awaiting_payment');
  return { result, data };
}

function paymentCallback(orderId, paymentId, user = members.alice, amountMinor = '1000') {
  return {
    ...callbackBase,
    contract: GSPAY_CALLBACK_PROJECTION_CONTRACT,
    source: 'gateway_callback',
    providerId: paymentId,
    transactionId: orderId,
    playerUsername: `player_${user === members.alice ? 'alice' : user === members.bob ? 'bob' : 'carol'}`,
    amountMinor,
    currency: 'MYR',
    providerState: 'paid',
    settlementStatus: 'independent_query_required',
  };
}

async function paymentIdFor(orderId) {
  return String((await one('portal_payment_orders', 'id=?', [orderId])).trade_no);
}

test.beforeEach(async () => {
  await withStorage(async () => {
    await sql.prepare(`DELETE FROM ${table('portal_gspay_attempts')}`).run();
    await sql.prepare(`DELETE FROM ${table('portal_gspay_callbacks')}`).run();
    await sql.prepare(`DELETE FROM ${table('portal_wallet_journal')}`).run();
    await sql.prepare(`DELETE FROM ${table('portal_payment_reviews')}`).run();
    await sql.prepare(`DELETE FROM ${table('portal_payment_orders')}`).run();
    await sql.prepare(`DELETE FROM ${table('audit')}`).run();
    await sql.prepare(`DELETE FROM ${table('portal_staff')}`).run();
    for (const user of Object.values(members)) {
      await sql.prepare(`UPDATE ${table('portal_users')} SET role='customer' WHERE id=?`).run(user.userId);
      await sql.prepare(`UPDATE ${table('members')} SET tenant_id='alpha' WHERE email=?`).run(user.email);
    }
  });
});

test('database reservation binds the member snapshot and one create claim across concurrent retries', async () => {
  const runtime = harness(), data = input();
  const results = await Promise.all(Array.from({ length: 8 }, () => runtime.core.submit(members.alice, data)));
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  assert.equal(runtime.calls.create, 1);
  assert.equal(await count('portal_payment_orders'), 1);
  assert.equal(await count('portal_gspay_attempts', " WHERE operation='create'"), 1);
  const row = await one('portal_payment_orders', 'id=?', [results[0].id]);
  assert.equal(row.provider, 'gspay_myr');
  assert.equal(row.trade_code, 'payment');
  assert.equal(row.provider_player_username, 'player_alice');
  assert.equal(String(row.amount_minor), '1000');
  assert.equal(row.create_outcome, 'created');
  assert.equal((await runtime.core.submit(members.alice, data)).status, 'awaiting_payment');
  await expectCode(() => runtime.core.submit(members.alice, { ...data, amount: '10.01' }), 'GSPAY_IDEMPOTENCY_CONFLICT');
  const other = await runtime.core.submit(members.bob, data);
  assert.notEqual(other.id, results[0].id);
  assert.equal(await count('portal_payment_orders'), 2);
});

test('an approved account without an explicit membership cannot reserve a main-tenant order', async () => {
  const runtime = harness();
  await withStorage(() => sql.prepare(`DELETE FROM ${table('members')} WHERE email=?`).run(members.alice.email));
  try {
    await expectCode(() => runtime.core.submit({ ...members.alice, tenantId: 'main' }, input()), 'GSPAY_INVALID_ORDER');
    assert.equal(runtime.calls.create, 0);
    assert.equal(await count('portal_payment_orders'), 0);
  } finally {
    await withStorage(() => sql.prepare(`INSERT INTO ${table('members')}(email,tenant_id,created_at) VALUES (?,?,?)`).run(
      members.alice.email, 'alpha', fixedTime,
    ));
  }
});

test('a lost create response stays unknown across factory restarts and is never resent', async () => {
  let calls = 0;
  const runtime = harness({ createError: new Error('synthetic private timeout') });
  const original = runtime.gateway.createPayment;
  runtime.gateway.createPayment = async draft => { calls++; return original(draft); };
  const data = input(), first = await runtime.core.submit(members.alice, data);
  assert.equal(first.status, 'awaiting_confirmation');
  assert.equal(calls, 1);
  const restarted = harness({ createError: new Error('must not run') });
  assert.equal((await restarted.core.submit(members.alice, data)).status, 'awaiting_confirmation');
  assert.equal(restarted.calls.create, 0);
  const order = await one('portal_payment_orders', 'id=?', [first.id]);
  assert.equal(order.create_outcome, 'unknown');
  const attempts = await all('portal_gspay_attempts', "order_id=? AND operation='create'", [first.id]);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].outcome, 'unknown');

  const recoveredPaymentId = '9123456789';
  await restarted.core.receiveCallback(
    'payment', paymentCallback(first.id, recoveredPaymentId), callbackContext,
  );
  const callbackBound = await one('portal_payment_orders', 'id=?', [first.id]);
  assert.equal(callbackBound.create_outcome, 'unknown');
  assert.equal(callbackBound.trade_code, 'payment');
  assert.equal(callbackBound.trade_no, recoveredPaymentId);
  assert.equal((await restarted.core.reconcile(first.id)).status, 'credited');
  const recovered = await one('portal_payment_orders', 'id=?', [first.id]);
  assert.equal(recovered.create_outcome, 'created');
  assert.equal(recovered.trade_code, 'payment');
  assert.equal(recovered.trade_no, recoveredPaymentId);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [first.id]), 1);
});

test('a trusted create result closes its attempt when an earlier callback query already entered review', async () => {
  const runtime = harness({ queryState: 'failed' });
  const originalCreate = runtime.gateway.createPayment;
  let callbackStatus;
  let reconcileStatus;
  runtime.gateway.createPayment = async draft => {
    const raw = await originalCreate(draft);
    callbackStatus = (await runtime.core.receiveCallback(
      'payment', paymentCallback(draft.transactionId, raw.paymentId), callbackContext,
    )).status;
    reconcileStatus = (await runtime.core.reconcile(draft.transactionId)).status;
    return raw;
  };

  const result = await runtime.core.submit(members.alice, input());
  assert.equal(callbackStatus, 'pending_query');
  assert.equal(reconcileStatus, 'review_required');
  assert.equal(result.status, 'review_required');
  const order = await one('portal_payment_orders', 'id=?', [result.id]);
  assert.equal(order.create_outcome, 'created');
  assert.equal(order.settlement_status, 'pending');
  assert.equal(Number(order.review_required), 1);
  assert(order.checkout_url);
  const createAttempt = await one('portal_gspay_attempts', "order_id=? AND operation='create'", [result.id]);
  assert.equal(createAttempt.outcome, 'succeeded');
  assert.equal(createAttempt.result_code, 'CREATE_CONFIRMED');
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 0);
});

test('a callback received before a timed-out create response closes the create attempt and later recovers once', async () => {
  const runtime = harness();
  const originalCreate = runtime.gateway.createPayment;
  runtime.gateway.createPayment = async draft => {
    const raw = await originalCreate(draft);
    await runtime.core.receiveCallback(
      'payment', paymentCallback(draft.transactionId, raw.paymentId), callbackContext,
    );
    throw new Error('synthetic timeout after provider acceptance');
  };

  const result = await runtime.core.submit(members.alice, input());
  assert.equal(result.status, 'awaiting_confirmation');
  const unknown = await one('portal_payment_orders', 'id=?', [result.id]);
  assert.equal(unknown.create_outcome, 'unknown');
  assert.equal(unknown.settlement_status, 'pending');
  const createAttempt = await one('portal_gspay_attempts', "order_id=? AND operation='create'", [result.id]);
  assert.equal(createAttempt.outcome, 'unknown');
  assert.equal(createAttempt.result_code, 'GSPAY_ORDER_CREATION_PENDING');

  assert.equal((await runtime.core.reconcile(result.id)).status, 'credited');
  assert.equal((await runtime.core.reconcile(result.id)).status, 'credited');
  const recovered = await one('portal_payment_orders', 'id=?', [result.id]);
  assert.equal(recovered.create_outcome, 'created');
  assert.equal(recovered.trade_code, 'payment');
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 1);
  assert.equal(runtime.calls.query, 1);
});

test('callback inbox is idempotent and persists only the safe semantic projection', async () => {
  const runtime = harness(), { result } = await createOrder(runtime);
  const callback = paymentCallback(result.id, await paymentIdFor(result.id));
  const first = await runtime.core.receiveCallback('payment', callback, callbackContext);
  const duplicate = await runtime.core.receiveCallback('payment', callback, callbackContext);
  assert.equal(first.eventId, duplicate.eventId);
  assert.equal(await count('portal_gspay_callbacks'), 1);
  assert.equal(await count('portal_wallet_journal'), 0);
  const saved = await one('portal_gspay_callbacks', 'event_key_hash=?', [first.eventId]);
  assert.equal(saved.processing_state, 'pending_query');
  assert.equal(saved.reported_status, 'paid');
  for (const forbidden of ['raw_payload', 'signature', 'remark', 'auth_key', 'secret', 'bank_name', 'account_number']) {
    assert.equal(Object.hasOwn(saved, forbidden), false);
  }
});

test('DuitNow callbacks stay out of automatic query settlement and close without wallet credit', async () => {
  const unsupportedRuntime = harness({ payableAmount: '10.01' });
  const unsupportedOrder = (await createOrder(unsupportedRuntime)).result;
  const unsupportedResult = await unsupportedRuntime.core.receiveCallback('duitnow', {
    ...callbackBase,
    contract: GSPAY_CALLBACK_PROJECTION_CONTRACT,
    source: 'gateway_duitnow_callback',
    providerId: await paymentIdFor(unsupportedOrder.id),
    transactionId: unsupportedOrder.id,
    amountMinor: '1001',
    currency: 'MYR',
    providerState: 'paid',
    settlementStatus: 'independent_query_required',
  }, callbackContext);
  assert.equal(unsupportedResult.status, 'review_required');
  const unsupportedCallback = await one('portal_gspay_callbacks', 'event_key_hash=?', [unsupportedResult.eventId]);
  assert.equal(unsupportedCallback.processing_state, 'review_required');
  assert.equal(unsupportedCallback.rejection_code, 'GSPAY_DUITNOW_QUERY_UNCONFIRMED');
  assert.equal(Number((await one('portal_payment_orders', 'id=?', [unsupportedOrder.id])).review_required), 1);
  assert.equal((await unsupportedRuntime.core.reconcile(unsupportedOrder.id)).status, 'review_required');

  const reviewRuntime = harness({ payableAmount: '10.01' });
  const reviewOrder = (await createOrder(reviewRuntime)).result;
  const reviewId = await paymentIdFor(reviewOrder.id);
  const reviewResult = await reviewRuntime.core.receiveCallback('duitnow', {
    ...callbackBase,
    contract: GSPAY_CALLBACK_PROJECTION_CONTRACT,
    source: 'gateway_duitnow_callback',
    providerId: reviewId,
    transactionId: reviewOrder.id,
    amountMinor: '1001',
    currency: 'MYR',
    providerState: 'manual_success_review',
    settlementStatus: 'finance_review_required',
  }, callbackContext);
  assert.equal(reviewResult.status, 'review_required');
  assert.equal((await one('portal_gspay_callbacks', 'event_key_hash=?', [reviewResult.eventId])).processing_state, 'review_required');
  assert.equal(Number((await one('portal_payment_orders', 'id=?', [reviewOrder.id])).review_required), 1);

  const rejectedRuntime = harness({ payableAmount: '10.01' });
  const rejectedOrder = (await createOrder(rejectedRuntime, members.bob)).result;
  const rejectedResult = await rejectedRuntime.core.receiveCallback('duitnow', {
    ...callbackBase,
    contract: GSPAY_CALLBACK_PROJECTION_CONTRACT,
    source: 'gateway_duitnow_callback',
    providerId: await paymentIdFor(rejectedOrder.id),
    transactionId: rejectedOrder.id,
    amountMinor: '1001',
    currency: 'MYR',
    providerState: 'timeout_or_rejected',
    settlementStatus: 'not_payable',
  }, callbackContext);
  assert.equal(rejectedResult.status, 'recorded');
  assert.equal((await one('portal_gspay_callbacks', 'event_key_hash=?', [rejectedResult.eventId])).processing_state, 'rejected');
  assert.equal(await count('portal_wallet_journal'), 0);
  assert.equal(unsupportedRuntime.calls.query + reviewRuntime.calls.query + rejectedRuntime.calls.query, 0);
});

test('pending query completes its attempt and a later paid query atomically credits exactly once', async () => {
  const runtime = harness({ queryState: 'pending' }), { result } = await createOrder(runtime);
  const paymentId = await paymentIdFor(result.id);
  const pendingInbox = await runtime.core.receiveCallback('payment', {
    ...paymentCallback(result.id, paymentId), providerState: 'pending',
  }, callbackContext);
  const paidInbox = await runtime.core.receiveCallback(
    'payment', paymentCallback(result.id, paymentId), callbackContext,
  );
  assert.notEqual(pendingInbox.eventId, paidInbox.eventId);
  assert.equal((await runtime.core.reconcile(result.id)).status, 'awaiting_payment');
  assert.equal(await count('portal_wallet_journal'), 0);
  runtime.setQueryState('paid');
  assert.equal((await runtime.core.reconcile(result.id)).status, 'credited');
  assert.equal((await runtime.core.reconcile(result.id)).status, 'credited');
  assert.equal(runtime.calls.query, 2);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 1);
  assert.equal((await one('portal_payment_orders', 'id=?', [result.id])).settlement_status, 'credited');
  assert.equal((await one('portal_gspay_callbacks', 'event_key_hash=?', [pendingInbox.eventId])).processing_state, 'processed');
  assert.equal((await one('portal_gspay_callbacks', 'event_key_hash=?', [paidInbox.eventId])).processing_state, 'processed');
  const attempts = await all('portal_gspay_attempts', "order_id=? AND operation='query'", [result.id]);
  assert.equal(attempts.length, 2);
  assert(attempts.every(attempt => attempt.outcome === 'succeeded'));
  assert.equal(await count('audit', ' WHERE action=?', [`GSPAY+ MYR 充值独立查单并入账：${result.id}`]), 1);
});

test('a matching payment callback arriving after credit is stored processed without another query', async () => {
  const runtime = harness(), { result } = await createOrder(runtime);
  const paymentId = await paymentIdFor(result.id);
  await runtime.core.receiveCallback('payment', {
    ...paymentCallback(result.id, paymentId), providerState: 'pending',
  }, callbackContext);
  assert.equal((await runtime.core.reconcile(result.id)).status, 'credited');
  assert.equal(runtime.calls.query, 1);
  const late = await runtime.core.receiveCallback(
    'payment', paymentCallback(result.id, paymentId), callbackContext,
  );
  assert.equal(late.status, 'recorded');
  assert.equal((await one('portal_gspay_callbacks', 'event_key_hash=?', [late.eventId])).processing_state, 'processed');
  assert.equal((await runtime.core.reconcile(result.id)).status, 'credited');
  assert.equal(runtime.calls.query, 1);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 1);
});

test('a paid callback followed by an authenticated failed query atomically enters review', async () => {
  const runtime = harness({ queryState: 'failed' }), { result } = await createOrder(runtime);
  const inbox = await runtime.core.receiveCallback(
    'payment', paymentCallback(result.id, await paymentIdFor(result.id)), callbackContext,
  );
  const prepared = [];
  const originalPrepare = sql.prepare;
  sql.prepare = function prepareWithTrace(source) {
    prepared.push(source.replace(/\s+/g, ' ').trim());
    return originalPrepare.call(sql, source);
  };
  try {
    assert.equal((await runtime.core.reconcile(result.id)).status, 'review_required');
  } finally {
    sql.prepare = originalPrepare;
  }
  const orderLock = prepared.findIndex(source =>
    source.startsWith('UPDATE portal_payment_orders SET id=id WHERE id=?'));
  const callbackConflictRead = prepared.findIndex(source =>
    source.startsWith('SELECT count(*) AS count FROM portal_gspay_callbacks'));
  assert.notEqual(orderLock, -1, 'terminal query handling must lock the order');
  assert.notEqual(callbackConflictRead, -1, 'terminal query handling must inspect matching paid callbacks');
  assert(orderLock < callbackConflictRead, 'the order lock must precede the callback conflict decision');
  assert.equal(runtime.calls.query, 1);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 0);
  const order = await one('portal_payment_orders', 'id=?', [result.id]);
  const callback = await one('portal_gspay_callbacks', 'event_key_hash=?', [inbox.eventId]);
  const attempt = await one('portal_gspay_attempts', "order_id=? AND operation='query'", [result.id]);
  assert.equal(Number(order.review_required), 1);
  assert.equal(order.settlement_status, 'pending');
  assert.equal(callback.processing_state, 'review_required');
  assert(callback.rejection_code);
  assert.equal(attempt.outcome, 'failed');
  assert.equal(attempt.observed_status, 'failed');
  assert(attempt.completed_at);
  assert.equal(await count('portal_payment_reviews', ' WHERE order_id=?', [result.id]), 1);
});

test('a reviewed order stores later payment callbacks as review without another query or credit', async () => {
  const runtime = harness({ queryState: 'failed' }), { result } = await createOrder(runtime);
  const paymentId = await paymentIdFor(result.id);
  await runtime.core.receiveCallback(
    'payment', paymentCallback(result.id, paymentId), callbackContext,
  );
  assert.equal((await runtime.core.reconcile(result.id)).status, 'review_required');
  assert.equal(runtime.calls.query, 1);

  const later = await runtime.core.receiveCallback('payment', {
    ...paymentCallback(result.id, paymentId), providerState: 'pending',
  }, callbackContext);
  assert.equal(later.status, 'review_required');
  const saved = await one('portal_gspay_callbacks', 'event_key_hash=?', [later.eventId]);
  assert.equal(saved.processing_state, 'review_required');
  assert.equal(saved.rejection_code, 'GSPAY_ORDER_ALREADY_UNDER_REVIEW');
  assert.equal((await runtime.core.reconcile(result.id)).status, 'review_required');
  assert.equal(runtime.calls.query, 1);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 0);
});

test('the payment discriminator is rechecked at create result, callback, and settlement boundaries', async () => {
  const createRuntime = harness();
  const originalCreate = createRuntime.gateway.createPayment;
  createRuntime.gateway.createPayment = async draft => {
    const raw = await originalCreate(draft);
    await withStorage(() => sql.prepare(`UPDATE ${table('portal_payment_orders')} SET trade_code='duitnow' WHERE id=?`).run(draft.transactionId));
    return raw;
  };
  const createResult = await createRuntime.core.submit(members.alice, input());
  assert.equal(createResult.status, 'awaiting_confirmation');
  const rejectedCreate = await one('portal_payment_orders', 'id=?', [createResult.id]);
  assert.equal(rejectedCreate.create_outcome, 'unknown');
  assert.equal(rejectedCreate.trade_no, null);
  assert.equal(rejectedCreate.checkout_url, null);

  const runtime = harness(), { result } = await createOrder(runtime, members.bob);
  const paymentId = await paymentIdFor(result.id);
  await withStorage(() => sql.prepare(`UPDATE ${table('portal_payment_orders')} SET trade_code='duitnow' WHERE id=?`).run(result.id));
  await expectCode(
    () => runtime.core.receiveCallback('payment', paymentCallback(result.id, paymentId, members.bob), callbackContext),
    'GSPAY_CALLBACK_MISMATCH',
  );
  assert.equal(await count('portal_gspay_callbacks', ' WHERE order_id=?', [result.id]), 0);

  await withStorage(() => sql.prepare(`UPDATE ${table('portal_payment_orders')} SET trade_code='payment' WHERE id=?`).run(result.id));
  await runtime.core.receiveCallback('payment', paymentCallback(result.id, paymentId, members.bob), callbackContext);
  const claim = await runtime.store.claimQuery(result.id, { attemptedAt: fixedTime });
  assert.equal(claim.claimed, true);
  const confirmation = await runtime.gateway.queryPayment({
    transactionId: claim.order.transactionId,
    paymentId: claim.order.paymentId,
    playerUsername: claim.order.playerUsername,
    amount: '10.00',
    amountMinor: '1000',
    currency: 'MYR',
  });
  await withStorage(() => sql.prepare(`UPDATE ${table('portal_payment_orders')} SET trade_code='duitnow' WHERE id=?`).run(result.id));
  await expectCode(
    () => runtime.settlement.commitConfirmed({ order: claim.order, confirmation, committedAt: fixedTime }),
    'GSPAY_SETTLEMENT_CONFLICT',
  );
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 0);
  assert.equal((await one('portal_payment_orders', 'id=?', [result.id])).settlement_status, 'pending');
});

test('concurrent query claims across the real store produce one query and one wallet entry', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = harness({ queryImpl: async expected => {
    await gate;
    return {
      ...gatewayBase,
      contract: GSPAY_QUERY_PROJECTION_CONTRACT,
      source: 'gateway_query',
      transactionId: expected.transactionId,
      paymentId: expected.paymentId,
      playerUsername: expected.playerUsername,
      currency: 'MYR',
      amount: expected.amount,
      amountMinor: expected.amountMinor,
      completed: true,
      success: true,
      providerState: 'paid',
      settlementStatus: 'query_confirmed',
    };
  } });
  const { result } = await createOrder(runtime);
  await runtime.core.receiveCallback('payment', paymentCallback(result.id, await paymentIdFor(result.id)), callbackContext);
  const requests = Array.from({ length: 10 }, () => runtime.core.reconcile(result.id));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await count('portal_gspay_attempts', " WHERE order_id=? AND operation='query' AND outcome='in_flight'", [result.id]), 1);
  release();
  const results = await Promise.all(requests);
  assert(results.some(value => value.status === 'credited'));
  assert.equal(runtime.calls.query, 1);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 1);
});

test('an expired query lease is fenced before restart recovery and only the new attempt can settle', async () => {
  let clockMs = Date.parse(fixedTime);
  const clock = () => new Date(clockMs);
  const crashed = harness({ clock }), { result } = await createOrder(crashed);
  const paymentId = await paymentIdFor(result.id);
  await crashed.core.receiveCallback('payment', paymentCallback(result.id, paymentId), callbackContext);

  const first = await crashed.store.claimQuery(result.id, { attemptedAt: clock().toISOString() });
  assert.equal(first.claimed, true);
  assert(first.order.queryAttemptId);
  const restarted = harness({ clock });
  const active = await restarted.store.claimQuery(result.id, { attemptedAt: clock().toISOString() });
  assert.equal(active.claimed, false, 'an active query lease must not be stolen');
  assert.equal(active.order.queryAttemptId, first.order.queryAttemptId);

  clockMs += 120_001;
  const second = await restarted.store.claimQuery(result.id, { attemptedAt: clock().toISOString() });
  assert.equal(second.claimed, true);
  assert.notEqual(second.order.queryAttemptId, first.order.queryAttemptId);
  const oldAttempt = await one('portal_gspay_attempts', 'id=?', [first.order.queryAttemptId]);
  assert.equal(oldAttempt.outcome, 'unknown');
  assert.equal(oldAttempt.result_code, 'GSPAY_QUERY_LEASE_EXPIRED');

  const confirmation = await restarted.gateway.queryPayment({
    transactionId: second.order.transactionId,
    paymentId: second.order.paymentId,
    playerUsername: second.order.playerUsername,
    amount: '10.00',
    amountMinor: '1000',
    currency: 'MYR',
  });
  await expectCode(
    () => crashed.settlement.commitConfirmed({ order: first.order, confirmation, committedAt: clock().toISOString() }),
    'GSPAY_SETTLEMENT_CONFLICT',
  );
  await crashed.store.finishQuery(result.id, {
    attemptId: first.order.queryAttemptId,
    queryState: 'pending',
    reason: 'GSPAY_SETTLEMENT_RETRY',
    updatedAt: clock().toISOString(),
  });
  const stillActive = await one('portal_gspay_attempts', 'id=?', [second.order.queryAttemptId]);
  assert.equal(stillActive.outcome, 'in_flight', 'late Q1 completion must not alter Q2');
  assert.equal((await one('portal_gspay_callbacks', 'order_id=?', [result.id])).processing_state, 'pending_query');
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 0);

  const settled = await restarted.settlement.commitConfirmed({
    order: second.order, confirmation, committedAt: clock().toISOString(),
  });
  assert.equal(settled.credited, true);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 1);
  assert.equal((await one('portal_gspay_callbacks', 'order_id=?', [result.id])).processing_state, 'processed');
  assert.equal((await one('portal_gspay_attempts', 'id=?', [second.order.queryAttemptId])).outcome, 'succeeded');
});

test('settlement locks the identity and membership rows before its authoritative member snapshot', async () => {
  const runtime = harness(), { result } = await createOrder(runtime);
  await runtime.core.receiveCallback(
    'payment', paymentCallback(result.id, await paymentIdFor(result.id)), callbackContext,
  );
  const prepared = [];
  const originalPrepare = sql.prepare;
  sql.prepare = function prepareWithTrace(source) {
    prepared.push(source.replace(/\s+/g, ' ').trim());
    return originalPrepare.call(sql, source);
  };
  try {
    assert.equal((await runtime.core.reconcile(result.id)).status, 'credited');
  } finally {
    sql.prepare = originalPrepare;
  }
  const identityLock = prepared.findIndex(source =>
    source.startsWith('UPDATE portal_users SET id=id WHERE id=?'));
  const membershipLock = prepared.findIndex(source =>
    source.startsWith('UPDATE members SET email=email WHERE email='));
  const authoritativeRead = prepared.findIndex(source =>
    source.startsWith('SELECT u.id,u.username,u.email,u.role,u.approved,'));
  assert.notEqual(identityLock, -1, 'settlement must take a strong lock on the portal identity row');
  assert.notEqual(membershipLock, -1, 'settlement must lock the current tenant-membership row');
  assert.notEqual(authoritativeRead, -1, 'settlement must re-read authoritative membership');
  assert(identityLock < membershipLock, 'identity lock must precede membership lock');
  assert(membershipLock < authoritativeRead, 'both locks must precede the membership snapshot');
});

test('membership, account-role, and staff changes are held for review before any credit', async () => {
  const mutations = [
    [members.alice, () => sql.prepare(`UPDATE ${table('members')} SET tenant_id='beta' WHERE email=?`).run(members.alice.email)],
    [members.bob, () => sql.prepare(`UPDATE ${table('portal_users')} SET role='owner' WHERE id=?`).run(members.bob.userId)],
    [members.carol, () => sql.prepare(`INSERT INTO ${table('portal_staff')}(user_id,tenant_id,role) VALUES (?,?,?)`).run(members.carol.userId, 'alpha', 'employee')],
  ];
  for (const [user, mutate] of mutations) {
    const runtime = harness(), { result } = await createOrder(runtime, user);
    const callback = paymentCallback(result.id, await paymentIdFor(result.id), user);
    const inbox = await runtime.core.receiveCallback('payment', callback, callbackContext);
    await withStorage(mutate);
    assert.equal((await runtime.core.reconcile(result.id)).status, 'review_required');
    assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 0);
    assert.equal(Number((await one('portal_payment_orders', 'id=?', [result.id])).review_required), 1);
    assert.equal((await one('portal_gspay_callbacks', 'event_key_hash=?', [inbox.eventId])).processing_state, 'review_required');
    assert.equal(await count('portal_payment_reviews', ' WHERE order_id=?', [result.id]), 1);
    await withStorage(async () => {
      await sql.prepare(`DELETE FROM ${table('portal_staff')} WHERE user_id=?`).run(user.userId);
      await sql.prepare(`UPDATE ${table('portal_users')} SET role='customer' WHERE id=?`).run(user.userId);
      await sql.prepare(`UPDATE ${table('members')} SET tenant_id='alpha' WHERE email=?`).run(user.email);
    });
  }
});

test('an audit insertion failure rolls back the order, wallet, callback, attempt, and audit together', async () => {
  const runtime = harness(), { result } = await createOrder(runtime);
  const inbox = await runtime.core.receiveCallback(
    'payment', paymentCallback(result.id, await paymentIdFor(result.id)), callbackContext,
  );
  const originalPrepare = sql.prepare;
  sql.prepare = function prepareWithFailure(source) {
    if (source.startsWith('INSERT INTO audit')) throw Error('synthetic audit failure');
    return originalPrepare.call(sql, source);
  };
  try {
    assert.equal((await runtime.core.reconcile(result.id)).status, 'awaiting_payment');
  } finally {
    sql.prepare = originalPrepare;
  }
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 0);
  assert.equal((await one('portal_payment_orders', 'id=?', [result.id])).settlement_status, 'pending');
  assert.equal((await one('portal_gspay_callbacks', 'event_key_hash=?', [inbox.eventId])).processing_state, 'pending_query');
  const attempts = await all('portal_gspay_attempts', "order_id=? AND operation='query'", [result.id]);
  assert.equal(attempts.length, 1);
  assert.notEqual(attempts[0].outcome, 'succeeded');
  assert.equal(await count('audit'), 0);
});

test('already-credited replay persists a review when its immutable wallet entry is inconsistent', async () => {
  const runtime = harness(), { result } = await createOrder(runtime);
  await runtime.core.receiveCallback('payment', paymentCallback(result.id, await paymentIdFor(result.id)), callbackContext);
  assert.equal((await runtime.core.reconcile(result.id)).status, 'credited');
  const order = await runtime.store.findById(result.id);
  const confirmation = await runtime.gateway.queryPayment({
    transactionId: order.transactionId,
    paymentId: order.paymentId,
    playerUsername: order.playerUsername,
    amount: '10.00',
    amountMinor: '1000',
    currency: 'MYR',
  });
  const replay = await runtime.settlement.commitConfirmed({ order, confirmation, committedAt: fixedTime });
  assert.equal(replay.alreadyCredited, true);
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 1);
  await withStorage(() => sql.prepare(`UPDATE ${table('portal_wallet_journal')}
    SET member_minor=999,clearing_minor=-999 WHERE order_id=?`).run(result.id));
  const inconsistent = await runtime.settlement.commitConfirmed({ order, confirmation, committedAt: fixedTime });
  assert.equal(inconsistent.reviewRequired, true);
  assert.equal(inconsistent.order.reviewRequired, true);
  const unchanged = await one('portal_wallet_journal', 'order_id=?', [result.id]);
  assert.equal(String(unchanged.member_minor), '999');
  assert.equal(String(unchanged.clearing_minor), '-999');
  assert.equal(await count('portal_wallet_journal', ' WHERE order_id=?', [result.id]), 1);
  assert.equal(Number((await one('portal_payment_orders', 'id=?', [result.id])).review_required), 1);
  const review = await one('portal_payment_reviews', 'order_id=?', [result.id]);
  assert.equal(review.reason, 'GSPAY_LEDGER_INCONSISTENT');
});

test.after(async () => {
  await sql.close();
  rmSync(directory, { recursive: true, force: true });
});
