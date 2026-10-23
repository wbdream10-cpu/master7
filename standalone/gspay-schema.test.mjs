import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

delete process.env.PORTAL_POSTGRES_URL;
delete process.env.RENDER;
process.env.NODE_ENV = 'test';
const postgres = process.argv.includes('--postgres');
const directory = mkdtempSync(join(tmpdir(), 'master7-gspay-schema-'));
process.env.PORTAL_DATABASE = join(directory, 'gspay.sqlite');
if (postgres) {
  process.env.PORTAL_TEST_POSTGRES = '1';
  process.env.PORTAL_TEST_POSTGRES_PATH = join(directory, 'postgres');
} else {
  delete process.env.PORTAL_TEST_POSTGRES;
  delete process.env.PORTAL_TEST_POSTGRES_PATH;
}
globalThis.fetch = () => { throw Error('Unexpected network access in GSPAY schema test'); };

const { sql, withStorage } = await import('./runtime.mjs');
const table = name => (postgres ? `portal_private.${name}` : name);
const count = async name => Number((await sql.prepare(`SELECT count(*) AS count FROM ${table(name)}`).get()).count);
const now = '2026-10-24T00:00:00.000Z';

await withStorage(async () => {
  await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run('alpha', 'Alpha', now);
  for (const [id, email] of [['alice', 'alice@example.test'], ['bob', 'bob@example.test']]) {
    await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run(id, id, email, 'synthetic-hash', 'customer', 1, 'synthetic-recovery', now);
    await sql.prepare('INSERT INTO members VALUES (?,?,?)').run(email, 'alpha', now);
  }
});

async function baseOrder(id, userId, provider, requestKey) {
  await sql.prepare(`INSERT INTO portal_payment_orders(
    id,tenant_id,user_id,request_key,merchant_id,environment,amount_minor,currency,
    settlement_status,review_required,created_at,provider,provider_amount_minor
  ) VALUES (?,?,?,?,'synthetic-merchant','uat',1000,'MYR','created',0,?,?,?)`).run(
    id, 'alpha', userId, requestKey, now, provider, provider === 'gspay_myr' ? 1000 : null,
  );
}

test('migration adds no operational data and reuses the common order ledger', async () => {
  const version = await sql.prepare('SELECT name FROM schema_versions WHERE name=?').get('0009_gspay_myr_checkout.sql');
  assert.equal(version.name, '0009_gspay_myr_checkout.sql');
  assert.equal(await count('portal_payment_orders'), 0);
  assert.equal(await count('portal_gspay_callbacks'), 0);
  assert.equal(await count('portal_gspay_attempts'), 0);
});

test('provider payable amount is exact and bounded', async () => {
  await baseOrder('gspay-order-1', 'alice', 'gspay_myr', 'gspay-request-1');
  await baseOrder('vpay-order-1', 'bob', 'vpay', 'vpay-request-1');
  const row = await sql.prepare('SELECT provider,amount_minor,provider_amount_minor FROM portal_payment_orders WHERE id=?').get('gspay-order-1');
  assert.deepEqual({ provider: row.provider, amount: Number(row.amount_minor), providerAmount: Number(row.provider_amount_minor) }, {
    provider: 'gspay_myr', amount: 1000, providerAmount: 1000,
  });
  await assert.rejects(() => sql.prepare('UPDATE portal_payment_orders SET provider_amount_minor=10000001 WHERE id=?').run('gspay-order-1'));
  await assert.rejects(() => sql.prepare('UPDATE portal_payment_orders SET provider_amount_minor=1000 WHERE id=?').run('vpay-order-1'));
});

test('sanitized callback inbox is idempotent, GSPAY-only, and query-gated', async () => {
  const eventHash = 'a'.repeat(64);
  await sql.prepare(`INSERT INTO ${table('portal_gspay_callbacks')}(
    id,order_id,event_key_hash,channel,provider_payment_id,reported_status,amount_minor,currency,processing_state,received_at
  ) VALUES (?,?,?,?,?,?,?,'MYR','pending_query',?)`).run(
    'callback-1', 'gspay-order-1', eventHash, 'payment', 'provider-payment-1', 'paid', 1000, now,
  );
  await assert.rejects(() => sql.prepare(`INSERT INTO ${table('portal_gspay_callbacks')}(
    id,order_id,event_key_hash,channel,provider_payment_id,reported_status,amount_minor,currency,processing_state,received_at
  ) VALUES (?,?,?,?,?,?,?,'MYR','pending_query',?)`).run(
    'callback-duplicate', 'gspay-order-1', eventHash, 'payment', 'provider-payment-1', 'paid', 1000, now,
  ));
  await assert.rejects(() => sql.prepare(`INSERT INTO ${table('portal_gspay_callbacks')}(
    id,order_id,event_key_hash,channel,provider_payment_id,reported_status,amount_minor,currency,processing_state,received_at
  ) VALUES (?,?,?,?,?,?,?,'MYR','pending_query',?)`).run(
    'callback-vpay-order', 'vpay-order-1', 'b'.repeat(64), 'payment', 'provider-payment-2', 'paid', 1000, now,
  ));
  await assert.rejects(() => sql.prepare(`INSERT INTO ${table('portal_gspay_callbacks')}(
    id,order_id,event_key_hash,channel,provider_payment_id,reported_status,amount_minor,currency,processing_state,received_at
  ) VALUES (?,?,?,?,?,?,?,'USD','pending_query',?)`).run(
    'callback-wrong-currency', 'gspay-order-1', 'c'.repeat(64), 'payment', 'provider-payment-3', 'paid', 1000, now,
  ));
  await assert.rejects(() => sql.prepare(`INSERT INTO ${table('portal_gspay_callbacks')}(
    id,order_id,event_key_hash,channel,provider_payment_id,reported_status,amount_minor,currency,processing_state,received_at
  ) VALUES (?,?,?,?,?,?,?,'MYR','pending_query',?)`).run(
    'callback-invalid-hash', 'gspay-order-1', 'z'.repeat(64), 'payment', 'provider-payment-4', 'paid', 1000, now,
  ));
  await assert.rejects(() => sql.prepare(`UPDATE ${table('portal_gspay_callbacks')}
    SET processing_state='processed' WHERE id='callback-1'`).run());
});

test('provider attempts retain bounded reconciliation fields and enforce operation transitions', async () => {
  await baseOrder('gspay-order-2', 'bob', 'gspay_myr', 'gspay-request-2');
  await sql.prepare(`INSERT INTO ${table('portal_gspay_attempts')}(
    id,order_id,callback_id,operation,attempt_key,outcome,started_at
  ) VALUES (?,?,?,?,?,'in_flight',?)`).run(
    'attempt-query-1', 'gspay-order-1', 'callback-1', 'query', 'query-attempt-0001', now,
  );
  await assert.rejects(() => sql.prepare(`INSERT INTO ${table('portal_gspay_attempts')}(
    id,order_id,callback_id,operation,attempt_key,outcome,started_at
  ) VALUES (?,?,?,?,?,'in_flight',?)`).run(
    'attempt-create-invalid', 'gspay-order-1', 'callback-1', 'create', 'create-attempt-0001', now,
  ));
  await assert.rejects(() => sql.prepare(`INSERT INTO ${table('portal_gspay_attempts')}(
    id,order_id,operation,attempt_key,outcome,started_at
  ) VALUES (?,?, 'query',?,'in_flight',?)`).run(
    'attempt-vpay-order', 'vpay-order-1', 'query-attempt-vpay1', now,
  ));
  await assert.rejects(() => sql.prepare(`INSERT INTO ${table('portal_gspay_attempts')}(
    id,order_id,callback_id,operation,attempt_key,outcome,started_at
  ) VALUES (?,?,?,?,?,'in_flight',?)`).run(
    'attempt-wrong-callback-order', 'gspay-order-2', 'callback-1', 'query', 'query-attempt-wrong1', now,
  ));
  await sql.prepare(`UPDATE ${table('portal_gspay_attempts')} SET
    outcome='succeeded',http_status=200,result_code='QUERY_CONFIRMED',
    observed_provider_payment_id='provider-payment-1',observed_status='paid',observed_amount_minor=1000,
    completed_at=? WHERE id='attempt-query-1'`).run('2026-10-24T00:00:01.000Z');
  await sql.prepare(`UPDATE ${table('portal_gspay_callbacks')} SET
    processing_state='processed',processed_at=? WHERE id='callback-1'`).run('2026-10-24T00:00:01.000Z');
  const callback = await sql.prepare(`SELECT * FROM ${table('portal_gspay_callbacks')} WHERE id=?`).get('callback-1');
  const attempt = await sql.prepare(`SELECT * FROM ${table('portal_gspay_attempts')} WHERE id=?`).get('attempt-query-1');
  assert.equal(callback.processing_state, 'processed');
  assert.equal(attempt.observed_status, 'paid');
  for (const row of [callback, attempt]) {
    for (const forbidden of ['raw_payload', 'signature', 'remark', 'auth_key', 'secret', 'bank_name', 'account_number']) {
      assert.equal(Object.hasOwn(row, forbidden), false);
    }
  }
});

test('invalid in-flight and create results fail closed', async () => {
  await assert.rejects(() => sql.prepare(`INSERT INTO ${table('portal_gspay_attempts')}(
    id,order_id,operation,attempt_key,outcome,http_status,started_at
  ) VALUES (?,?, 'create',?,'in_flight',200,?)`).run(
    'attempt-invalid-inflight', 'gspay-order-1', 'create-attempt-0002', now,
  ));
  await assert.rejects(() => sql.prepare(`INSERT INTO ${table('portal_gspay_attempts')}(
    id,order_id,operation,attempt_key,outcome,observed_status,started_at,completed_at
  ) VALUES (?,?, 'create',?,'succeeded','paid',?,?)`).run(
    'attempt-create-observation', 'gspay-order-1', 'create-attempt-0003', now, now,
  ));
});

test.after(async () => {
  await sql.close();
  rmSync(directory, { recursive: true, force: true });
});
