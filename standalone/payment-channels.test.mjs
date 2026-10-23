import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaymentChannelsHandler, GATEWAY_STATUS_URL } from './payment-channels.mjs';

const owner = { userId: 'owner-1', role: 'owner', email: 'owner@example.test' };
const customer = { userId: 'customer-1', role: 'customer', email: 'customer@example.test' };
const tenantOwner = { userId: 'tenant-owner-1', role: 'tenant_owner', tenantId: 'tenant-a', email: 'tenant-owner@example.test' };
const validGateway = (overrides = {}) => ({
  provider: 'vpay', version: '1.7.0', mode: 'uat', configured: true,
  readiness: { channels: { payment: { configurationReady: true, liveReady: false } } },
  ...overrides,
});
const response = (data, init = {}) => new Response(JSON.stringify(data), {
  status: 200, headers: { 'Content-Type': 'application/json' }, ...init,
});
const handler = (options = {}) => createPaymentChannelsHandler({
  getMemberTenant: async () => 'tenant-a',
  tenantExists: async id => id === 'tenant-a' || id === 'tenant-b',
  fetchImpl: async () => response(validGateway()),
  ...options,
});
const assertClosed = data => {
  assert.deepEqual(data.channels.map(channel => channel.id), ['vpay', 'gspay_myr', 'gspay_usdt']);
  assert(data.channels.every(channel => channel.enabled === false && channel.status === 'not_open' && channel.message === '暂未开放'));
  assert.deepEqual(data.channels.map(channel => channel.currency), ['MYR', 'MYR', 'USDT']);
  assert.equal(data.fundsProcessed, false);
};

test('anonymous, employees and unknown roles are rejected before any upstream request', async () => {
  let calls = 0;
  const get = handler({ fetchImpl: async () => { calls++; return response(validGateway()); } });
  for (const [user, status] of [[null, 401], [{ ...customer, role: 'employee' }, 403], [{ ...customer, role: 'administrator' }, 403]]) {
    assert.equal((await get(user)).status, status);
  }
  assert.equal(calls, 0);
});

test('customer and tenant owner scope cannot be changed by a selected tenant', async () => {
  let calls = 0;
  const get = handler({ fetchImpl: async () => { calls++; return response(validGateway()); } });
  assert.equal((await get(customer, 'tenant-b')).status, 403);
  assert.equal((await get(tenantOwner, 'tenant-b')).status, 403);
  assert.equal((await get({ ...tenantOwner, tenantId: null })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await (await get(customer, 'tenant-a')).json()).tenantId, 'tenant-a');
  assert.equal((await (await get(tenantOwner, 'tenant-a')).json()).tenantId, 'tenant-a');
});

test('headquarters can select an existing tenant, but not a missing one', async () => {
  let calls = 0;
  const get = handler({ fetchImpl: async () => { calls++; return response(validGateway()); } });
  assert.equal((await get(owner, 'missing')).status, 404);
  assert.equal((await get(owner, 'x'.repeat(61))).status, 400);
  assert.equal(calls, 0);
  assert.equal((await (await get(owner, 'tenant-b')).json()).tenantId, 'tenant-b');
});

test('only the fixed gateway URL is fetched using GET without caller credentials or redirects', async () => {
  let calls = 0;
  const get = handler({ fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, GATEWAY_STATUS_URL);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    assert.equal(options.body, undefined);
    assert(options.signal instanceof AbortSignal);
    return response(validGateway());
  } });
  const result = await get({ ...customer, url: 'https://attacker.example/', cookie: 'private-cookie', token: 'private-token' });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assertClosed(await result.json());
  assert.equal(calls, 1);
});

test('configured UAT readiness is shown only in headquarters diagnostics, never as an enabled channel', async () => {
  const get = handler({ fetchImpl: async () => response(validGateway({
    secret: 'private-do-not-expose',
    blockers: ['INTERNAL_ENV_NAME', 'private-do-not-expose'],
  })) });
  const normal = await (await get(customer)).json();
  assertClosed(normal);
  assert.equal(normal.diagnostics, undefined);
  assert(!JSON.stringify(normal).includes('INTERNAL_ENV_NAME'));
  assert(!JSON.stringify(normal).includes('uat'));
  const admin = await (await get(owner)).json();
  assertClosed(admin);
  assert.equal(admin.diagnostics.gateway.mode, 'uat');
  assert.equal(admin.diagnostics.gateway.configured, true);
  assert.equal(admin.diagnostics.gateway.configurationReady, true);
  assert.equal(admin.diagnostics.gateway.liveReady, false);
  assert.equal(admin.diagnostics.limitations.gspay_myr, 'offline_contract_verified_adapter_disabled');
  assert.equal(admin.diagnostics.limitations.gspay_usdt, 'new_orders_stopped');
  assert(!JSON.stringify(admin).includes('private-do-not-expose'));
  assert(!JSON.stringify(admin).includes('INTERNAL_ENV_NAME'));
});

test('even fully ready production metadata cannot enable orders in this portal', async () => {
  const get = handler({ fetchImpl: async () => response(validGateway({
    mode: 'production',
    readiness: { channels: { payment: { configurationReady: true, liveReady: true } } },
  })) });
  const data = await (await get(owner)).json();
  assertClosed(data);
  assert.equal(data.diagnostics.gateway.mode, 'production');
  assert.equal(data.diagnostics.gateway.liveReady, true);
  assert.equal(data.diagnostics.limitations.vpay, 'checkout_disabled_until_production_qa');
});

test('old or incomplete readiness fields stay unknown instead of becoming true', async () => {
  const get = handler({ fetchImpl: async () => response({ provider: 'vpay', configured: 'true', mode: 'preview', version: 'private-invalid-version', readiness: {} }) });
  const data = await (await get(owner)).json();
  assertClosed(data);
  assert.equal(data.diagnostics.gateway.configured, null);
  assert.equal(data.diagnostics.gateway.mode, 'unknown');
  assert.equal(data.diagnostics.gateway.configurationReady, null);
  assert.equal(data.diagnostics.gateway.liveReady, null);
  assert.equal(data.diagnostics.gateway.version, null);
});

test('malformed JSON, non-JSON, wrong provider and redirects fail closed with sanitized diagnostics', async () => {
  const cases = [
    [() => new Response('{private-invalid', { headers: { 'Content-Type': 'application/json' } }), 'GATEWAY_INVALID_JSON'],
    [() => new Response('<html>private</html>', { headers: { 'Content-Type': 'text/html' } }), 'GATEWAY_INVALID_CONTENT_TYPE'],
    [() => response({ provider: 'other', private: 'private-data' }), 'GATEWAY_INVALID_RESPONSE'],
    [() => response([], {}), 'GATEWAY_INVALID_RESPONSE'],
    [() => new Response(null, { status: 302, headers: { Location: 'https://attacker.example/' } }), 'GATEWAY_HTTP_ERROR'],
    [() => { const r = response(validGateway()); Object.defineProperty(r, 'redirected', { value: true }); return r; }, 'GATEWAY_REDIRECT_BLOCKED'],
    [() => { const r = response(validGateway()); Object.defineProperty(r, 'url', { value: 'https://attacker.example/' }); return r; }, 'GATEWAY_REDIRECT_BLOCKED'],
  ];
  for (const [make, code] of cases) {
    let calls = 0;
    const get = handler({ fetchImpl: async () => { calls++; return make(); } });
    const data = await (await get(owner)).json();
    assertClosed(data);
    assert.equal(data.diagnostics.gateway.reachable, false);
    assert.equal(data.diagnostics.gateway.errorCode, code);
    assert.equal(data.diagnostics.gateway.configured, null);
    assert(!JSON.stringify(data).includes('private-data'));
    assert.equal(calls, 1);
  }
});

test('timeout also bounds injected transports that never resolve and aborts their signal', async () => {
  let signal;
  const get = handler({ timeoutMs: 10, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const data = await (await get(owner)).json();
  assertClosed(data);
  assert.equal(data.diagnostics.gateway.errorCode, 'GATEWAY_TIMEOUT');
  assert.equal(signal.aborted, true);
});

test('both declared and streamed oversized responses are rejected', async () => {
  for (const headers of [{ 'Content-Type': 'application/json', 'Content-Length': '1000' }, { 'Content-Type': 'application/json' }]) {
    const get = handler({ maxResponseBytes: 32, fetchImpl: async () => new Response('x'.repeat(1000), { headers }) });
    const data = await (await get(owner)).json();
    assertClosed(data);
    assert.equal(data.diagnostics.gateway.errorCode, 'GATEWAY_RESPONSE_TOO_LARGE');
  }
});

test('transport errors and storage errors never return secret error text', async () => {
  const failedFetch = handler({ fetchImpl: async () => { throw Error('secret-token-and-private-url'); } });
  const gatewayData = await (await failedFetch(owner)).json();
  assert.equal(gatewayData.diagnostics.gateway.errorCode, 'GATEWAY_UNAVAILABLE');
  assert(!JSON.stringify(gatewayData).includes('secret-token'));
  let calls = 0;
  const failedStorage = handler({ getMemberTenant: async () => { throw Error('secret-database-url'); }, fetchImpl: async () => { calls++; return response(validGateway()); } });
  const result = await failedStorage(customer);
  assert.equal(result.status, 503);
  assert(!(await result.text()).includes('secret-database'));
  assert.equal(calls, 0);
});

test('concurrent requests share a read and short cache, then a failed refresh replaces the prior snapshot', async () => {
  let clock = 10000, calls = 0, fail = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const get = handler({ now: () => clock, cacheMs: 50, fetchImpl: async () => {
    calls++;
    await gate;
    if (fail) throw Error('upstream-failure');
    return response(validGateway());
  } });
  const pending = [get(owner), get(customer), get(tenantOwner)];
  release();
  const results = await Promise.all(pending);
  assert.equal(calls, 1);
  for (const result of results) assertClosed(await result.json());
  await get(owner);
  assert.equal(calls, 1);
  clock += 51;
  fail = true;
  const failed = await (await get(owner)).json();
  assert.equal(calls, 2);
  assert.equal(failed.diagnostics.gateway.configured, null);
  assert.equal(failed.diagnostics.gateway.reachable, false);
  assert.equal(failed.diagnostics.gateway.errorCode, 'GATEWAY_UNAVAILABLE');
});
