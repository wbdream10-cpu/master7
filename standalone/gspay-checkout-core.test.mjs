import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createGSPayCheckoutCore,
  GSPayCheckoutError,
  GSPAY_CALLBACK_PROJECTION_CONTRACT,
  GSPAY_CREATE_PROJECTION_CONTRACT,
  GSPAY_QUERY_PROJECTION_CONTRACT,
} from './gspay-checkout-core.mjs';

const member = { userId: 'member_1', role: 'customer', tenantId: 'alpha', playerUsername: 'member_1' };
const other = { userId: 'member_2', role: 'customer', tenantId: 'alpha', playerUsername: 'member_2' };
const readiness = Object.freeze({ provider: 'gspay_myr', configured: true, contractVersionConfirmed: true,
  ordersReady: true, callbacksReady: true, queryReady: true, liveReady: true });
const projectionBase = Object.freeze({ provider: 'gspay_myr', gatewayAuthenticated: true,
  signatureVerified: true, fundsProcessed: false });
const callbackBase = Object.freeze({ provider: 'gspay_myr', signatureVerified: true, fundsProcessed: false });
const callbackContext = Object.freeze({ gatewayAuthenticated: true });
let sequence = 0;
const input = () => ({ amount: '10.00', currency: 'MYR', requestKey: `synthetic_request_${++sequence}` });
const errorCode = async (action, code) => assert.rejects(action, error =>
  error instanceof GSPayCheckoutError && error.code === code && error.message === code);

function memoryStore() {
  const orders = new Map(), byRequest = new Map(), callbacks = new Map();
  const copy = value => value ? structuredClone(value) : value;
  return {
    orders, callbacks,
    async reserve(intent) {
      const key = `${intent.userId}:${intent.requestKey}`;
      if (byRequest.has(key)) return { order: copy(orders.get(byRequest.get(key))), created: false };
      const order = { ...intent, transactionId: intent.id, provider: 'gspay_myr', createState: 'not_sent',
        settlementStatus: 'created', reviewRequired: false, paymentId: null, payUrl: null, expiresAtRaw: null,
        payableAmount: null, queryState: 'idle' };
      orders.set(order.id, order); byRequest.set(key, order.id);
      return { order: copy(order), created: true };
    },
    async claimCreate(id, { fingerprint, attemptedAt }) {
      const order = orders.get(id);
      if (order.createState !== 'not_sent') return { claimed: false, order: copy(order) };
      order.createState = 'in_flight'; order.fingerprint = fingerprint; order.createAttemptedAt = attemptedAt;
      return { claimed: true, order: copy(order) };
    },
    async markCreated(id, projection) {
      const order = orders.get(id);
      if (order.paymentId && order.paymentId !== projection.paymentId) throw Error('binding conflict');
      Object.assign(order, projection, { createState: 'created', settlementStatus: 'pending' });
      return copy(order);
    },
    async markCreateUnknown(id, update) {
      const order = orders.get(id); Object.assign(order, update, { createState: 'unknown' }); return copy(order);
    },
    async findByTransactionId(id) { return copy(orders.get(id)); },
    async findById(id) { return copy(orders.get(id)); },
    async recordCallback(id, projection) {
      const order = orders.get(id);
      if (order.paymentId && order.paymentId !== projection.providerId) throw Error('binding conflict');
      order.paymentId ||= projection.providerId;
      callbacks.set(projection.eventId, copy(projection));
      return { stored: true, order: copy(order) };
    },
    async claimQuery(id, { attemptedAt }) {
      const order = orders.get(id);
      if (order.settlementStatus === 'credited' || order.queryState === 'in_flight') return { claimed: false, order: copy(order) };
      order.queryState = 'in_flight'; order.queryAttemptedAt = attemptedAt;
      return { claimed: true, order: copy(order) };
    },
    async finishQuery(id, update) {
      const order = orders.get(id); Object.assign(order, update); return copy(order);
    },
    copy,
  };
}

function createHarness(overrides = {}) {
  const store = overrides.store || memoryStore();
  const calls = { create: 0, query: 0, commit: 0 };
  const gateway = overrides.gateway || {
    status: () => readiness,
    async createPayment(draft) { calls.create++; return { draft }; },
    async queryPayment({ transactionId }) {
      calls.query++;
      const order = store.orders.get(transactionId);
      return { ...projectionBase, contract: GSPAY_QUERY_PROJECTION_CONTRACT, source: 'gateway_query', paymentId: order.paymentId || '10001',
        transactionId, playerUsername: order.playerUsername, amount: '10.00', amountMinor: String(order.amountMinor), currency: 'MYR',
        completed: true, success: true, providerState: 'paid', settlementStatus: 'query_confirmed' };
    },
  };
  const settlement = overrides.settlement || {
    async commitConfirmed({ order, confirmation, committedAt }) {
      calls.commit++;
      const current = store.orders.get(order.id);
      if (current.settlementStatus === 'credited') return { alreadyCredited: true, order: store.copy(current) };
      assert.equal(confirmation.signatureVerified, true);
      Object.assign(current, { settlementStatus: 'credited', queryState: 'confirmed', creditedAt: committedAt,
        paymentId: confirmation.paymentId, walletJournalWritten: true, auditWritten: true, callbackAttemptCompleted: true });
      return { credited: true, order: store.copy(current) };
    },
  };
  const inspectCreateResult = overrides.inspectCreateResult === undefined
    ? ((_raw, expected) => ({ ...projectionBase, contract: GSPAY_CREATE_PROJECTION_CONTRACT, source: 'gateway_create', createSchemaConfirmed: true,
      paymentId: '10001', transactionId: expected.transactionId, payUrl: 'https://pay.example.test/checkout',
      expiresAtRaw: '2026-10-24 12:34:56' }))
    : overrides.inspectCreateResult;
  let ids = 0;
  const core = createGSPayCheckoutCore({
    ordersEnabled: true, callbacksEnabled: true, settlementEnabled: true,
    allowedPaymentOrigins: ['https://pay.example.test'], inspectCreateResult,
    resolvePlayerUsername: async user => user.playerUsername,
    store, gateway, settlement, idFactory: () => `transaction_${++ids}`,
    now: () => new Date('2026-10-24T00:00:00.000Z'), ...overrides.options,
  });
  return { core, store, gateway, settlement, calls };
}

test('default, unconfirmed and gateway-not-ready configurations fail closed without side effects', async () => {
  const counts = { reserve: 0, create: 0, query: 0, commit: 0 };
  const store = { reserve: async () => { counts.reserve++; }, claimCreate: async () => {}, markCreated: async () => {},
    markCreateUnknown: async () => {}, findByTransactionId: async () => {}, recordCallback: async () => {},
    findById: async () => {}, claimQuery: async () => {}, finishQuery: async () => {} };
  const gateway = { status: () => ({ ...readiness, ordersReady: false, queryReady: false, liveReady: false }),
    createPayment: async () => { counts.create++; }, queryPayment: async () => { counts.query++; } };
  const settlement = { commitConfirmed: async () => { counts.commit++; } };
  const closed = createGSPayCheckoutCore({ store, gateway, settlement });
  assert.deepEqual(closed.status(), { provider: 'gspay_myr', currency: 'MYR', enabled: false,
    ordersEnabled: false, callbacksEnabled: false, settlementEnabled: false, liveReady: false });
  await errorCode(() => closed.submit(member, input()), 'GSPAY_CHECKOUT_DISABLED');
  await errorCode(() => closed.receiveCallback('payment', {}), 'GSPAY_CALLBACKS_DISABLED');
  await errorCode(() => closed.reconcile('transaction_1'), 'GSPAY_SETTLEMENT_DISABLED');
  const requested = createGSPayCheckoutCore({ ordersEnabled: true, callbacksEnabled: true, settlementEnabled: true,
    allowedPaymentOrigins: ['https://pay.example.test'], resolvePlayerUsername: async user => user.playerUsername,
    inspectCreateResult: () => ({}), store, gateway, settlement });
  assert.deepEqual(requested.status(), { provider: 'gspay_myr', currency: 'MYR', enabled: false,
    ordersEnabled: false, callbacksEnabled: true, settlementEnabled: false, liveReady: false });
  await errorCode(() => requested.submit(member, input()), 'GSPAY_CHECKOUT_DISABLED');
  await errorCode(() => requested.reconcile('transaction_1'), 'GSPAY_SETTLEMENT_DISABLED');
  assert.deepEqual(counts, { reserve: 0, create: 0, query: 0, commit: 0 });
});

test('missing confirmed create schema and player resolver keep orders closed', async () => {
  const { store, gateway, settlement } = createHarness();
  for (const omission of ['inspectCreateResult', 'resolvePlayerUsername']) {
    const options = { ordersEnabled: true, callbacksEnabled: true, settlementEnabled: true,
      allowedPaymentOrigins: ['https://pay.example.test'], inspectCreateResult: () => ({}),
      resolvePlayerUsername: async () => 'member_1', store, gateway, settlement };
    delete options[omission];
    const core = createGSPayCheckoutCore(options);
    assert.equal(core.status().ordersEnabled, false);
    await errorCode(() => core.submit(member, input()), 'GSPAY_CHECKOUT_DISABLED');
  }
});

test('submission validates identity, resolved player, exact MYR and request key before reserving', async () => {
  const { core, store, calls } = createHarness();
  for (const [user, change, code] of [
    [null, {}, 'GSPAY_MEMBER_UNAVAILABLE'], [{ ...member, role: 'owner' }, {}, 'GSPAY_MEMBER_UNAVAILABLE'],
    [member, { amount: 10 }, 'GSPAY_INVALID_ORDER'], [member, { amount: '0' }, 'GSPAY_INVALID_ORDER'],
    [member, { amount: '100000.01' }, 'GSPAY_INVALID_ORDER'], [member, { currency: 'USD' }, 'GSPAY_INVALID_ORDER'],
    [member, { requestKey: 'short' }, 'GSPAY_INVALID_ORDER'],
  ]) await errorCode(() => core.submit(user, { ...input(), ...change }), code);
  const badPlayer = createHarness({ options: { resolvePlayerUsername: async () => 'Member Name' } }).core;
  await errorCode(() => badPlayer.submit(member, input()), 'GSPAY_INVALID_ORDER');
  assert.equal(store.orders.size, 0); assert.equal(calls.create, 0);
});

test('idempotent retries keep one local order and one gateway create attempt', async () => {
  const { core, store, calls } = createHarness(), data = input();
  const first = await core.submit(member, data), second = await core.submit(member, data);
  assert.deepEqual(first, second); assert.equal(first.status, 'awaiting_payment');
  assert.equal(first.payUrl, 'https://pay.example.test/checkout');
  assert.equal(store.orders.size, 1); assert.equal(calls.create, 1);
  await errorCode(() => core.submit(member, { ...data, amount: '10.01' }), 'GSPAY_IDEMPOTENCY_CONFLICT');
  const otherResult = await core.submit(other, data);
  assert.notEqual(otherResult.id, first.id); assert.equal(store.orders.size, 2); assert.equal(calls.create, 2);
});

test('lost create responses stay unknown across restarts and are never automatically resent', async () => {
  const store = memoryStore(); let calls = 0;
  const gateway = { status: () => readiness, async createPayment() { calls++; throw Error('private timeout detail'); },
    async queryPayment() { throw Error(); } };
  const data = input();
  const result = await createHarness({ store, gateway }).core.submit(member, data);
  assert.equal(result.status, 'awaiting_confirmation'); assert.equal(result.payUrl, null); assert.equal(calls, 1);
  assert.equal((await createHarness({ store, gateway }).core.submit(member, data)).status, 'awaiting_confirmation');
  assert.equal(calls, 1); assert.equal([...store.orders.values()][0].reason, 'GSPAY_ORDER_CREATION_PENDING');
});

test('create projection requires gateway attestation, confirmed schema and constrained URL', async () => {
  for (const result of [
    { ...projectionBase, contract: 'gspay-myr-create-v2', source: 'gateway_create', createSchemaConfirmed: true, transactionId: 'transaction_1', paymentId: '10001', payUrl: 'https://pay.example.test/checkout', expiresAtRaw: '2026-10-24' },
    { ...projectionBase, contract: GSPAY_CREATE_PROJECTION_CONTRACT, source: 'gateway_create', createSchemaConfirmed: true, transactionId: 'transaction_1', paymentId: '10001', payUrl: 'https://attacker.example/checkout', expiresAtRaw: '2026-10-24' },
    { ...projectionBase, contract: GSPAY_CREATE_PROJECTION_CONTRACT, source: 'gateway_create', createSchemaConfirmed: false, transactionId: 'transaction_1', paymentId: '10001', payUrl: 'https://pay.example.test/checkout', expiresAtRaw: '2026-10-24' },
    { ...projectionBase, contract: GSPAY_CREATE_PROJECTION_CONTRACT, source: 'gateway_create', createSchemaConfirmed: true, transactionId: 'transaction_1', paymentId: 'unsafe', payUrl: 'https://pay.example.test/checkout', expiresAtRaw: '2026-10-24' },
    { ...projectionBase, contract: GSPAY_CREATE_PROJECTION_CONTRACT, source: 'gateway_create', createSchemaConfirmed: true, transactionId: 'transaction_1', paymentId: '10001', payUrl: 'https://pay.example.test/checkout#fragment', expiresAtRaw: '2026-10-24' },
    { ...projectionBase, contract: GSPAY_CREATE_PROJECTION_CONTRACT, source: 'gateway_create', createSchemaConfirmed: true, transactionId: 'transaction_1', paymentId: '10001', payUrl: `https://pay.example.test/${'x'.repeat(2050)}`, expiresAtRaw: '2026-10-24' },
    { ...projectionBase, contract: GSPAY_CREATE_PROJECTION_CONTRACT, source: 'gateway_create', gatewayAuthenticated: false, createSchemaConfirmed: true, transactionId: 'transaction_1', paymentId: '10001', payUrl: 'https://pay.example.test/checkout', expiresAtRaw: '2026-10-24' },
  ]) {
    const { core, store } = createHarness({ inspectCreateResult: () => result });
    const response = await core.submit(member, input());
    assert.equal(response.status, 'awaiting_confirmation'); assert.equal(response.payUrl, null);
    assert.equal([...store.orders.values()][0].createState, 'unknown');
  }
});

test('gateway callback records a safe inbox projection and never implies supplier ACK or wallet credit', async () => {
  const { core, store, calls } = createHarness(); const order = await core.submit(member, input());
  const callback = { ...callbackBase, contract: GSPAY_CALLBACK_PROJECTION_CONTRACT, source: 'gateway_callback', providerId: '10001', transactionId: order.id,
    playerUsername: member.playerUsername, amountMinor: '1000', currency: 'MYR', providerState: 'paid',
    settlementStatus: 'independent_query_required' };
  const result = await core.receiveCallback('payment', callback, callbackContext);
  assert.deepEqual(Object.keys(result).sort(), ['eventId', 'fundsProcessed', 'orderId', 'recorded', 'status']);
  assert.equal(result.recorded, true); assert.equal(result.status, 'pending_query'); assert.equal(result.fundsProcessed, false);
  assert.equal(calls.query, 0); assert.equal(calls.commit, 0); assert.equal(store.callbacks.size, 1);
  const saved = JSON.stringify([...store.callbacks.values()][0]);
  for (const field of ['signature', 'remark', 'authKey', 'operatorSecretKey', 'SUCCESS']) assert(!saved.includes(field));
  assert.equal((await core.receiveCallback('payment', callback, callbackContext)).eventId, result.eventId);
  assert.equal(store.callbacks.size, 1);
});

test('callback identity, amount, provider id, attestation and raw fields cannot be recorded', async () => {
  const { core, store } = createHarness(); const order = await core.submit(member, input());
  const valid = { ...callbackBase, contract: GSPAY_CALLBACK_PROJECTION_CONTRACT, source: 'gateway_callback', providerId: '10001', transactionId: order.id,
    playerUsername: member.playerUsername, amountMinor: '1000', currency: 'MYR', providerState: 'paid',
    settlementStatus: 'independent_query_required' };
  for (const [change, code] of [
    [{ amountMinor: '1001' }, 'GSPAY_CALLBACK_MISMATCH'], [{ playerUsername: 'another_member' }, 'GSPAY_CALLBACK_MISMATCH'],
    [{ providerId: '10002' }, 'GSPAY_CALLBACK_MISMATCH'], [{ gatewayAuthenticated: true }, 'GSPAY_GATEWAY_RESULT_INVALID'],
    [{ signatureVerified: false }, 'GSPAY_GATEWAY_RESULT_INVALID'], [{ signature: 'private' }, 'GSPAY_GATEWAY_RESULT_INVALID'],
    [{ contract: 'gspay-myr-callback-v2' }, 'GSPAY_GATEWAY_RESULT_INVALID'],
  ]) await errorCode(() => core.receiveCallback('payment', { ...valid, ...change }, callbackContext), code);
  await errorCode(() => core.receiveCallback('payment', valid), 'GSPAY_GATEWAY_RESULT_INVALID');
  assert.equal(store.callbacks.size, 0);
});

test('only an independent attested paid query reaches one atomic commit', async () => {
  const { core, store, calls } = createHarness(); const order = await core.submit(member, input());
  await core.receiveCallback('payment', { ...callbackBase, contract: GSPAY_CALLBACK_PROJECTION_CONTRACT, source: 'gateway_callback', providerId: '10001',
    transactionId: order.id, playerUsername: member.playerUsername, amountMinor: '1000', currency: 'MYR',
    providerState: 'paid', settlementStatus: 'independent_query_required' }, callbackContext);
  assert.equal((await core.reconcile(order.id)).status, 'credited');
  assert.equal((await core.reconcile(order.id)).status, 'credited');
  assert.equal(calls.query, 1); assert.equal(calls.commit, 1);
  const current = store.orders.get(order.id);
  assert.equal(current.settlementStatus, 'credited'); assert.equal(current.walletJournalWritten, true);
  assert.equal(current.auditWritten, true); assert.equal(current.callbackAttemptCompleted, true);
});

test('pending, failed, mismatched, unauthenticated, wrong-contract and errored queries never commit', async () => {
  for (const mode of ['pending', 'failed', 'mismatch', 'unauthenticated', 'contract', 'error']) {
    const store = memoryStore(); let queryCalls = 0, commitCalls = 0;
    const gateway = { status: () => readiness, async createPayment(draft) { return { draft }; },
      async queryPayment({ transactionId }) {
        queryCalls++; if (mode === 'error') throw Error('private upstream error');
        const order = store.orders.get(transactionId), pending = mode === 'pending', failed = mode === 'failed';
        return { ...projectionBase, contract: mode === 'contract' ? 'gspay-myr-query-v2' : GSPAY_QUERY_PROJECTION_CONTRACT, source: 'gateway_query', gatewayAuthenticated: mode !== 'unauthenticated', paymentId: '10001',
          transactionId, playerUsername: order.playerUsername, amountMinor: mode === 'mismatch' ? '1001' : '1000',
          amount: mode === 'mismatch' ? '10.01' : '10.00', currency: 'MYR', completed: !pending, success: !pending && !failed,
          providerState: pending ? 'pending' : failed ? 'failed' : 'paid',
          settlementStatus: pending || failed ? 'not_payable' : 'query_confirmed' };
      } };
    const settlement = { async commitConfirmed() { commitCalls++; throw Error('must not run'); } };
    const { core } = createHarness({ store, gateway, settlement });
    const order = await core.submit(member, input()), result = await core.reconcile(order.id);
    assert.notEqual(result.status, 'credited'); assert.equal(queryCalls, 1); assert.equal(commitCalls, 0);
  }
});

test('an atomic commit failure releases the query claim for a safe retry', async () => {
  const store = memoryStore(); let commitCalls = 0;
  const settlement = { async commitConfirmed() { commitCalls++; throw Error('private database failure'); } };
  const { core } = createHarness({ store, settlement }); const order = await core.submit(member, input());
  assert.equal((await core.reconcile(order.id)).status, 'awaiting_payment');
  assert.equal(store.orders.get(order.id).queryState, 'pending');
  assert.equal(store.orders.get(order.id).reason, 'GSPAY_SETTLEMENT_RETRY');
  assert.equal((await core.reconcile(order.id)).status, 'awaiting_payment');
  assert.equal(commitCalls, 2);
});

test('a pending query can retry and concurrent claims do not duplicate atomic commit', async () => {
  const store = memoryStore(); let queryCalls = 0, commitCalls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const gateway = { status: () => readiness, async createPayment(draft) { return { draft }; },
    async queryPayment({ transactionId }) {
      queryCalls++; const order = store.orders.get(transactionId), pending = queryCalls === 1;
      if (!pending) await gate;
      return { ...projectionBase, contract: GSPAY_QUERY_PROJECTION_CONTRACT, source: 'gateway_query', paymentId: '10001', transactionId,
        playerUsername: order.playerUsername, amount: '10.00', amountMinor: '1000', currency: 'MYR', completed: !pending,
        success: !pending, providerState: pending ? 'pending' : 'paid',
        settlementStatus: pending ? 'not_payable' : 'query_confirmed' };
    } };
  const settlement = { async commitConfirmed({ order }) {
    commitCalls++; const current = store.orders.get(order.id); current.settlementStatus = 'credited';
    current.queryState = 'confirmed'; return { credited: true, order: store.copy(current) };
  } };
  const { core } = createHarness({ store, gateway, settlement }); const order = await core.submit(member, input());
  assert.equal((await core.reconcile(order.id)).status, 'awaiting_payment');
  const attempts = [core.reconcile(order.id), core.reconcile(order.id), core.reconcile(order.id)];
  await new Promise(resolve => setTimeout(resolve, 10)); release();
  const results = await Promise.all(attempts);
  assert(results.some(result => result.status === 'credited'));
  assert.equal(queryCalls, 2); assert.equal(commitCalls, 1);
});

test('DuitNow manual success is recorded for review and never settles directly', async () => {
  const { core, store, calls } = createHarness({ inspectCreateResult: (raw, expected) => ({ ...projectionBase,
    contract: GSPAY_CREATE_PROJECTION_CONTRACT, source: 'gateway_create', createSchemaConfirmed: true, transactionId: expected.transactionId, paymentId: '20002',
    payUrl: 'https://pay.example.test/checkout', expiresAtRaw: '2026-10-24', payableAmount: '10.01' }) });
  const order = await core.submit(member, input());
  const result = await core.receiveCallback('duitnow', { ...callbackBase, contract: GSPAY_CALLBACK_PROJECTION_CONTRACT, source: 'gateway_duitnow_callback',
    providerId: '20002', transactionId: order.id, amountMinor: '1001', currency: 'MYR',
    providerState: 'manual_success_review', settlementStatus: 'finance_review_required' }, callbackContext);
  assert.equal(result.status, 'review_required'); assert.equal(result.fundsProcessed, false);
  assert.equal(calls.query, 0); assert.equal(calls.commit, 0); assert.equal(store.callbacks.size, 1);
});
