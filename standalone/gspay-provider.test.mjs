import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GSPAY_GATEWAY_ORIGIN,
  GSPAY_GATEWAY_QUERY_CONTRACT,
  GSPAY_GATEWAY_RESPONSE_MAX_BYTES,
  createGSPayMYRProvider,
} from './gspay-provider.mjs';

const orderToken = 'synthetic-gspay-order-token-at-least-32-bytes';
const queryToken = 'synthetic-gspay-query-token-at-least-32-bytes';
const callbackToken = 'synthetic-gspay-callback-token-at-least-32-bytes';
const input = Object.freeze({
  transactionId: 'gspay_order_0001',
  playerUsername: 'member_001',
  amount: '10.00',
  currency: 'MYR',
});
const env = (changes = {}) => ({
  PORTAL_GSPAY_ENVIRONMENT: 'uat',
  PORTAL_GSPAY_ORDER_TOKEN: orderToken,
  PORTAL_GSPAY_QUERY_TOKEN: queryToken,
  PORTAL_GSPAY_CALLBACK_TOKEN: callbackToken,
  ...changes,
});
const config = (changes = {}) => ({
  provider: 'gspay',
  currency: 'MYR',
  mode: 'uat',
  configured: true,
  providerBase: 'https://api.thegspay.com',
  transactionRoutesActive: true,
  orderReady: false,
  queryReady: true,
  callbacksReady: false,
  callbackUrls: {},
  blockers: {},
  ...changes,
});
const queryResult = (changes = {}) => ({
  provider: 'gspay_myr',
  contract: GSPAY_GATEWAY_QUERY_CONTRACT,
  upstreamStatus: 200,
  result: {
    transactionId: input.transactionId,
    paymentId: '90071992547409931234',
    playerUsername: input.playerUsername,
    currency: 'MYR',
    amount: '10.00',
    amountMinor: '1000',
    completed: true,
    success: true,
    providerState: 'paid',
    signatureVerified: true,
    settlementStatus: 'query_confirmed',
    fundsProcessed: false,
    ...changes,
  },
});
const json = value => Response.json(value, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });

test('missing, weak, reused, or invalid-mode portal peer credentials stay offline', async () => {
  const cases = [
    {},
    env({ PORTAL_GSPAY_ENVIRONMENT: 'disabled' }),
    env({ PORTAL_GSPAY_ORDER_TOKEN: 'weak' }),
    env({ PORTAL_GSPAY_QUERY_TOKEN: orderToken }),
    env({ PORTAL_GSPAY_CALLBACK_TOKEN: queryToken }),
    env({ PORTAL_VPAY_QUERY_TOKEN: queryToken }),
  ];
  for (const environment of cases) {
    let calls = 0;
    const provider = createGSPayMYRProvider({ env: environment, fetchImpl: async () => { calls++; return json({}); } });
    assert.equal(provider.status().configured, false);
    assert.equal(provider.status().ordersReady, false);
    assert.equal(provider.status().queryReady, false);
    await assert.rejects(provider.configuration(), { code: 'GSPAY_GATEWAY_UNAVAILABLE' });
    await assert.rejects(provider.queryPayment(input), { code: 'GSPAY_GATEWAY_UNAVAILABLE' });
    assert.equal(calls, 0);
  }
});

test('order creation is hard closed before any gateway or supplier request', async () => {
  let calls = 0;
  const provider = createGSPayMYRProvider({
    env: env({
      PORTAL_GSPAY_OPERATOR_AUTHENTICATION_KEY: 'supplier-auth-must-never-be-read',
      PORTAL_GSPAY_OPERATOR_SECRET_KEY: 'supplier-secret-must-never-be-read',
      PORTAL_GSPAY_GATEWAY_URL: 'https://attacker.invalid',
    }),
    fetchImpl: async () => { calls++; return json(config({ orderReady: true })); },
  });
  await assert.rejects(provider.createPayment(input), { code: 'GSPAY_CREATE_SCHEMA_UNCONFIRMED' });
  await assert.rejects(provider.createPayment({ ...input, amount: 10 }), { code: 'GSPAY_INVALID_ORDER' });
  assert.equal(calls, 0);
  assert.deepEqual(provider.status(), {
    provider: 'gspay_myr', gatewayOrigin: GSPAY_GATEWAY_ORIGIN, environment: 'uat',
    configured: true, contractVersionConfirmed: false, ordersReady: false,
    queryReady: false, callbacksReady: false, liveReady: false, fundsProcessed: false,
  });
});

test('the current closed gateway config blocks query before the money route', async () => {
  const calls = [];
  const provider = createGSPayMYRProvider({
    env: env(),
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return json(config({ transactionRoutesActive: false, queryReady: false }));
    },
  });
  await assert.rejects(provider.queryPayment(input), { code: 'GSPAY_QUERY_CONTRACT_UNCONFIRMED' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${GSPAY_GATEWAY_ORIGIN}/platform/gspay/config`);
  assert.equal(calls[0].request.headers.Authorization, `Bearer ${queryToken}`);
});

test('query uses only the fixed integration gateway and projects the explicit internal contract', async () => {
  const calls = [];
  const provider = createGSPayMYRProvider({
    env: env({
      PORTAL_GSPAY_GATEWAY_URL: 'https://attacker.invalid',
      PORTAL_GSPAY_OPERATOR_AUTHENTICATION_KEY: 'supplier-auth-must-never-be-used',
      PORTAL_GSPAY_OPERATOR_SECRET_KEY: 'supplier-secret-must-never-be-used',
    }),
    fetchImpl: async (url, request) => {
      calls.push({ url, request });
      return json(url.endsWith('/config') ? config() : queryResult());
    },
  });
  const result = await provider.queryPayment(input);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(call => call.url), [
    `${GSPAY_GATEWAY_ORIGIN}/platform/gspay/config`,
    `${GSPAY_GATEWAY_ORIGIN}/platform/gspay/order-query`,
  ]);
  for (const call of calls) {
    assert.equal(call.request.redirect, 'error');
    assert.equal(call.request.headers.Authorization, `Bearer ${queryToken}`);
    assert.equal(new URL(call.url).origin, GSPAY_GATEWAY_ORIGIN);
  }
  assert.equal(calls[1].request.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].request.body), {
    transactionId: input.transactionId,
    paymentId: null,
    playerUsername: input.playerUsername,
    amount: '10.00',
    currency: 'MYR',
    contract: GSPAY_GATEWAY_QUERY_CONTRACT,
  });
  assert.deepEqual(result, {
    provider: 'gspay_myr', contract: GSPAY_GATEWAY_QUERY_CONTRACT,
    source: 'gateway_query', gatewayAuthenticated: true, transactionId: input.transactionId,
    paymentId: '90071992547409931234', playerUsername: input.playerUsername,
    currency: 'MYR', amount: '10.00', amountMinor: '1000', completed: true,
    success: true, providerState: 'paid', signatureVerified: true,
    settlementStatus: 'query_confirmed', fundsProcessed: false,
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of [orderToken, queryToken, callbackToken, 'supplier-auth', 'supplier-secret']) {
    assert(!serialized.includes(forbidden));
  }
});

test('query response must match the exact gateway contract and local order', async () => {
  const invalidResponses = [
    { ...queryResult(), raw: 'provider body' },
    { ...queryResult(), provider: 'gspay' },
    { ...queryResult(), contract: 'unknown-v2' },
    { ...queryResult(), upstreamStatus: 201 },
    queryResult({ transactionId: 'different_order_0001' }),
    queryResult({ playerUsername: 'other_member' }),
    queryResult({ amount: '10.01' }),
    queryResult({ amountMinor: '1001' }),
    queryResult({ paymentId: 9007199254740994 }),
    queryResult({ signatureVerified: false }),
    queryResult({ completed: false, success: true, providerState: 'pending', settlementStatus: 'not_payable' }),
    queryResult({ providerState: 'failed' }),
    queryResult({ settlementStatus: 'not_payable' }),
    queryResult({ rawSignature: 'secret' }),
  ];
  for (const invalid of invalidResponses) {
    let call = 0;
    const provider = createGSPayMYRProvider({
      env: env(),
      fetchImpl: async () => json(call++ === 0 ? config() : invalid),
    });
    await assert.rejects(provider.queryPayment(input), { code: 'GSPAY_GATEWAY_INVALID_RESPONSE' });
  }
});

test('transport rejects redirects, cross-origin finals, status/content errors, malformed JSON, and oversized bodies', async () => {
  const redirected = json(config());
  Object.defineProperty(redirected, 'redirected', { value: true });
  const crossOrigin = json(config());
  Object.defineProperty(crossOrigin, 'url', { value: 'https://attacker.invalid/result' });
  const wrongStatus = Response.json(config(), { status: 201 });
  const wrongType = new Response(JSON.stringify(config()), { headers: { 'Content-Type': 'text/plain' } });
  const malformed = new Response('{', { headers: { 'Content-Type': 'application/json' } });
  const declaredLarge = new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(GSPAY_GATEWAY_RESPONSE_MAX_BYTES + 1) } });
  const streamedLarge = new Response('x'.repeat(GSPAY_GATEWAY_RESPONSE_MAX_BYTES + 1), { headers: { 'Content-Type': 'application/json' } });
  for (const response of [redirected, crossOrigin, wrongStatus, wrongType, malformed, declaredLarge, streamedLarge]) {
    const provider = createGSPayMYRProvider({ env: env(), fetchImpl: async () => response });
    await assert.rejects(provider.configuration(), error =>
      error?.code === 'GSPAY_GATEWAY_UNAVAILABLE' || error?.code === 'GSPAY_GATEWAY_INVALID_RESPONSE');
  }
});

test('timeout bounds an injected gateway transport that ignores abort', async () => {
  let signal;
  const provider = createGSPayMYRProvider({
    env: env(),
    timeoutMs: 5,
    fetchImpl: async (_url, request) => {
      signal = request.signal;
      return new Promise(() => {});
    },
  });
  const started = Date.now();
  await assert.rejects(provider.configuration(), { code: 'GSPAY_GATEWAY_UNAVAILABLE' });
  assert.equal(signal.aborted, true);
  assert(Date.now() - started < 500);
});
