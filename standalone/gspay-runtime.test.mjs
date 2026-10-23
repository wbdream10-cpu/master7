import assert from 'node:assert/strict';
import test from 'node:test';
import { createGSPayRuntime, GSPAY_CALLBACK_MAX_BYTES, GSPAY_SETTLEMENT_DISABLED } from './gspay-runtime.mjs';

const callbackToken = 'synthetic-gspay-callback-token-at-least-32-bytes';
const owner = { userId: 'owner', email: 'owner@example.test', role: 'owner', tenantId: null };
const boss = { userId: 'boss', email: 'boss@example.test', role: 'tenant_owner', tenantId: 'alpha' };
const employee = { userId: 'employee', email: 'employee@example.test', role: 'employee', tenantId: 'alpha' };
const member = { userId: 'member', email: 'member@example.test', role: 'customer', tenantId: null };

function runtime(overrides = {}) {
  const state = { storageCalls: 0 };
  const core = createGSPayRuntime({
    env: { PORTAL_GSPAY_CALLBACK_TOKEN: callbackToken, ...overrides.env },
    getMemberTenant: async email => { state.storageCalls++; return email === member.email ? 'alpha' : null; },
    tenantExists: async id => { state.storageCalls++; return ['alpha', 'beta'].includes(id); },
  });
  return { core, state };
}

const read = response => response.json();
const request = (core, {
  token = callbackToken,
  body = '{}',
  contentType = 'application/json',
  channel = 'payment',
  readBody,
} = {}) => core.receive({
  authorization: token === null ? undefined : `Bearer ${token}`,
  contentType,
  channel,
  readBody: readBody || (async () => Buffer.from(body)),
});

test('authenticated config is tenant-scoped, fixed closed, and fully sanitized', async () => {
  const { core } = runtime({ env: {
    PORTAL_GSPAY_OPERATOR_AUTHENTICATION_KEY: 'private-auth-key-never-returned',
    PORTAL_GSPAY_OPERATOR_SECRET_KEY: 'private-secret-key-never-returned',
    PORTAL_GSPAY_CALLBACK_SOURCE_IP: '192.0.2.77',
  } });
  assert.equal((await core.status(null)).status, 401);
  assert.equal((await core.status(employee)).status, 403);
  assert.equal((await core.status(boss, 'beta')).status, 403);
  assert.equal((await core.status(owner, 'missing')).status, 404);

  const result = await read(await core.status(member));
  assert.deepEqual(result, {
    tenantId: 'alpha',
    provider: 'gspay_myr',
    currency: 'MYR',
    enabled: false,
    ordersEnabled: false,
    callbacksEnabled: false,
    settlementEnabled: false,
    liveReady: false,
    mode: 'disabled',
    blockers: [GSPAY_SETTLEMENT_DISABLED],
  });
  const serialized = JSON.stringify(result);
  for (const forbidden of [callbackToken, 'private-auth-key', 'private-secret-key', '192.0.2.77', 'configured', 'token', 'secret', 'ip']) {
    assert(!serialized.toLowerCase().includes(forbidden.toLowerCase()), forbidden);
  }
  assert.equal((await read(await core.status(owner, 'beta'))).tenantId, 'beta');
});

test('machine entry authenticates before reading and never touches storage or fetch', async () => {
  const { core, state } = runtime();
  const nativeFetch = globalThis.fetch;
  let fetchCalls = 0, reads = 0;
  globalThis.fetch = async () => { fetchCalls++; throw Error('network must remain unused'); };
  const countedBody = async () => { reads++; return Buffer.from('{"private":"must-not-return"}'); };
  try {
    assert.equal((await request(core, { token: null, readBody: countedBody })).status, 401);
    assert.equal((await request(core, { token: 'x'.repeat(Buffer.byteLength(callbackToken)), readBody: countedBody })).status, 401);
    assert.equal(reads, 0);
    assert.equal((await request(core, { contentType: 'text/plain', readBody: countedBody })).status, 415);
    assert.equal(reads, 0);

    const result = await request(core, { readBody: countedBody });
    assert.equal(result.status, 503);
    const text = await result.text();
    assert.equal(JSON.parse(text).error, GSPAY_SETTLEMENT_DISABLED);
    assert(!text.includes('SUCCESS'));
    assert(!text.includes('must-not-return'));
    assert.equal(reads, 1);
    assert.equal(state.storageCalls, 0);
    assert.equal(fetchCalls, 0);
  } finally { globalThis.fetch = nativeFetch; }
});

test('configured callback rejects malformed, non-object, oversized and unsupported requests', async () => {
  const { core, state } = runtime();
  assert.equal((await request(core, { body: '{' })).status, 400);
  assert.equal((await request(core, { body: '[]' })).status, 400);
  assert.equal((await request(core, { body: 'null' })).status, 400);
  assert.equal((await request(core, { body: '"string"' })).status, 400);
  assert.equal((await request(core, { body: 'x'.repeat(GSPAY_CALLBACK_MAX_BYTES + 1) })).status, 413);
  assert.equal((await request(core, { readBody: async () => { throw Error('TOO_LARGE'); } })).status, 413);
  assert.equal((await request(core, { channel: 'payout' })).status, 400);
  assert.equal((await request(core, { channel: 'duitnow', body: '{"status":2}' })).status, 503);
  assert.equal(state.storageCalls, 0);
});

test('missing, weak, or reused callback credential remains closed before body parsing', async () => {
  for (const env of [
    {},
    { PORTAL_GSPAY_CALLBACK_TOKEN: 'short' },
    { PORTAL_GSPAY_CALLBACK_TOKEN: callbackToken, PORTAL_VPAY_CALLBACK_TOKEN: callbackToken },
    { PORTAL_GSPAY_CALLBACK_TOKEN: callbackToken, PORTAL_VPAY_QUERY_TOKEN: callbackToken },
    { PORTAL_GSPAY_CALLBACK_TOKEN: callbackToken, PORTAL_GAMES_GATEWAY_TOKEN: callbackToken },
    { PORTAL_GSPAY_CALLBACK_TOKEN: callbackToken, PORTAL_HOOK_LEGACY: callbackToken },
    { PORTAL_GSPAY_CALLBACK_TOKEN: callbackToken, PORTAL_GSPAY_OPERATOR_SECRET_KEY: callbackToken },
  ]) {
    let reads = 0;
    const core = createGSPayRuntime({ env, getMemberTenant: async () => null, tenantExists: async () => true });
    const response = await core.receive({
      authorization: `Bearer ${callbackToken}`,
      contentType: 'application/json',
      readBody: async () => { reads++; return Buffer.from('{}'); },
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, GSPAY_SETTLEMENT_DISABLED);
    assert.equal(reads, 0);
  }
});
