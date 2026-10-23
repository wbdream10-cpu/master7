import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

delete process.env.PORTAL_POSTGRES_URL;
delete process.env.PORTAL_TEST_POSTGRES;
delete process.env.RENDER;
process.env.NODE_ENV = 'test';
const directory = mkdtempSync(join(tmpdir(), 'master7-gspay-runtime-http-'));
process.env.PORTAL_DATABASE = join(directory, 'gspay.sqlite');
process.env.PUBLIC_ORIGIN = 'https://portal.example.test';
process.env.PORTAL_ALLOWED_ORIGINS = 'https://master7.vip,https://master7.best';
process.env.PORTAL_GSPAY_CALLBACK_TOKEN = 'synthetic-gspay-http-callback-token-at-least-32-bytes';
process.env.PORTAL_VPAY_CALLBACK_TOKEN = 'different-synthetic-vpay-callback-token-at-least-32-bytes';
process.env.PORTAL_VPAY_QUERY_TOKEN = 'different-synthetic-vpay-query-token-at-least-32-bytes';
process.env.PORTAL_VPAY_ORDER_TOKEN = 'different-synthetic-vpay-order-token-at-least-32-bytes';
process.env.PORTAL_GSPAY_OPERATOR_AUTHENTICATION_KEY = 'private-auth-key-never-returned';
process.env.PORTAL_GSPAY_OPERATOR_SECRET_KEY = 'private-secret-key-never-returned';
process.env.PORTAL_GSPAY_CALLBACK_SOURCE_IP = '192.0.2.88';

const nativeFetch = globalThis.fetch;
let externalFetches = 0;
const { sql, withStorage } = await import('./runtime.mjs');
const { newSession } = await import('./security.mjs');
const { server } = await import('./server.mjs');
const createdAt = new Date().toISOString();

await withStorage(async () => {
  for (const id of ['alpha', 'beta']) await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run(id, id, createdAt);
  const users = [
    ['member', 'member@example.test', 'customer'],
    ['owner', 'owner@example.test', 'owner'],
    ['boss', 'boss@example.test', 'customer'],
    ['employee', 'employee@example.test', 'customer'],
  ];
  for (const [id, email, role] of users) {
    await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(id, id, email, 'synthetic-hash', role, 1, 'synthetic-recovery', createdAt);
  }
  await sql.prepare('INSERT INTO members VALUES (?,?,?)').run('member@example.test', 'alpha', createdAt);
  await sql.prepare('INSERT INTO members VALUES (?,?,?)').run('boss@example.test', 'alpha', createdAt);
  await sql.prepare('INSERT INTO members VALUES (?,?,?)').run('employee@example.test', 'alpha', createdAt);
  await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?)').run('boss', 'alpha', 'tenant_owner');
  await sql.prepare('INSERT INTO portal_staff VALUES (?,?,?)').run('employee', 'alpha', 'employee');
});

const cookies = {};
for (const id of ['member', 'owner', 'boss', 'employee']) cookies[id] = `portal_session=${await newSession(id)}`;
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
globalThis.fetch = (input, options) => {
  const url = String(input);
  if (!url.startsWith(base)) {
    externalFetches++;
    throw Error('Unexpected external network access in GSPAY runtime HTTP test');
  }
  return nativeFetch(input, options);
};
const call = (path, options = {}) => fetch(base + path, { redirect: 'manual', ...options });
const bearer = { Authorization: `Bearer ${process.env.PORTAL_GSPAY_CALLBACK_TOKEN}` };
const callback = (path, body = '{}', headers = {}) => call(path, {
  method: 'POST',
  headers: { ...bearer, 'Content-Type': 'application/json', ...headers },
  body,
});
const counts = () => withStorage(async () => {
  const result = {};
  for (const table of ['audit', 'portal_payment_orders', 'portal_wallet_journal']) {
    result[table] = Number((await sql.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()).total);
  }
  return result;
});

try {
  assert.equal((await call('/api/v1/payments/gspay/config')).status, 401);
  assert.equal((await call('/api/v1/payments/gspay/config', { headers: { Cookie: cookies.employee } })).status, 403);
  assert.equal((await call('/api/v1/payments/gspay/config?tenant=beta', { headers: { Cookie: cookies.member } })).status, 403);
  assert.equal((await call('/api/v1/payments/gspay/config?tenant=missing', { headers: { Cookie: cookies.owner } })).status, 404);
  const memberStatus = await (await call('/api/v1/payments/gspay/config', { headers: { Cookie: cookies.member } })).json();
  assert.deepEqual(memberStatus, {
    tenantId: 'alpha', provider: 'gspay_myr', currency: 'MYR', enabled: false,
    ordersEnabled: false, callbacksEnabled: false, queryEnabled: false,
    settlementEnabled: false, providerSchemaConfirmed: false,
    liveReady: false, mode: 'disabled',
    blockers: ['GSPAY_CREATE_SCHEMA_UNCONFIRMED', 'GSPAY_SETTLEMENT_DISABLED'],
  });
  const ownerStatus = await (await call('/api/v1/payments/gspay/config?tenant=beta', { headers: { Cookie: cookies.owner } })).json();
  assert.equal(ownerStatus.tenantId, 'beta');
  const serializedStatus = JSON.stringify(ownerStatus);
  for (const forbidden of [process.env.PORTAL_GSPAY_CALLBACK_TOKEN, 'private-auth-key', 'private-secret-key', '192.0.2.88']) assert(!serializedStatus.includes(forbidden));

  const machineBefore = await counts();
  assert.equal((await call('/api/v1/payment-callbacks/gspay/payment')).status, 405);
  assert.equal((await callback('/api/v1/payment-callbacks/gspay/payment', '{}', { Authorization: '' })).status, 401);
  assert.equal((await call('/api/v1/payment-callbacks/gspay/payment', { method: 'POST', headers: { Cookie: cookies.owner, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await callback('/api/v1/payment-callbacks/gspay/payment', '{}', { Authorization: 'Bearer wrong-token-that-is-at-least-32-bytes' })).status, 401);
  assert.equal((await callback('/api/v1/payment-callbacks/gspay/payment', '{}', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await callback('/api/v1/payment-callbacks/gspay/payment', '{')).status, 400);
  assert.equal((await callback('/api/v1/payment-callbacks/gspay/payment', '[]')).status, 400);
  assert.equal((await callback('/api/v1/payment-callbacks/gspay/payment', `{"padding":"${'x'.repeat(17 * 1024)}"}`)).status, 413);

  const privatePayload = JSON.stringify({
    transaction_id: 'private-transaction-must-not-return',
    signature: 'private-signature-must-not-return',
    remark: 'private-remark-must-not-return',
    amount: '10.00',
  });
  const payment = await callback('/api/v1/payment-callbacks/gspay/payment', privatePayload, { Origin: 'https://attacker.example.test' });
  assert.equal(payment.status, 503);
  const paymentText = await payment.text();
  assert.deepEqual(JSON.parse(paymentText), { error: 'GSPAY_SETTLEMENT_DISABLED' });
  for (const forbidden of ['SUCCESS', 'private-transaction', 'private-signature', 'private-remark']) assert(!paymentText.includes(forbidden));
  const duitnow = await callback('/api/v1/payment-callbacks/gspay/duitnow', JSON.stringify({ status: 2 }));
  assert.equal(duitnow.status, 503);
  assert.deepEqual(await duitnow.json(), { error: 'GSPAY_SETTLEMENT_DISABLED' });
  assert.deepEqual(await counts(), machineBefore);
  assert.equal(externalFetches, 0);

  for (const publicSupplierPath of [
    '/api/payment/gspay/callback',
    '/api/payment/gspay/duitnow/callback',
    '/api/payment/gspay/payout/callback',
    '/api/v1/payments/gspay/orders',
    '/api/v1/payment-callbacks/gspay/payout',
    '/api/v1/payment-callbacks/gspay/usdt',
  ]) {
    assert.equal((await call(publicSupplierPath)).status, 404);
    assert.equal((await call(publicSupplierPath, {
      method: 'POST',
      body: 'x'.repeat(17 * 1024),
    })).status, 404);
  }
  console.log('PASS: GSPAY+ MYR config is tenant-scoped and sanitized; internal machine callbacks authenticate before bounded JSON parsing and remain 503 with zero fetch, audit, order, journal, wallet or acknowledgement effects.');
} finally {
  globalThis.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
  await sql.close();
  rmSync(directory, { recursive: true, force: true });
}
