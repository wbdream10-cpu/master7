import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated synthetic HTTP fixture only. The hosted portal stays service-only.
delete process.env.PORTAL_POSTGRES_URL;
delete process.env.RENDER;
process.env.NODE_ENV = 'test';

const directory = mkdtempSync(join(tmpdir(), 'master7-sponsored-games-http-'));
const nativeFetch = globalThis.fetch;
process.env.PUBLIC_ORIGIN = 'http://127.0.0.1:8080';
process.env.PORTAL_DATABASE = join(directory, 'portal.sqlite');
process.env.PORTAL_GAMES_GATEWAY_URL = 'https://master7-integration-gateway.onrender.com';
process.env.PORTAL_GAMES_GATEWAY_TOKEN = 'synthetic-http-test-token-at-least-32-bytes';
process.env.PORTAL_GAMES_GATEWAY_MODE = 'uat';

let upstreamCalls = 0;
globalThis.fetch = async (url, options) => {
  upstreamCalls++;
  assert.equal(url, 'https://master7-integration-gateway.onrender.com/providers/jili/games?account=1to1');
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(options.headers, {
    Accept: 'application/json',
    Authorization: 'Bearer synthetic-http-test-token-at-least-32-bytes',
  });
  return Response.json({
    provider: 'jili',
    account: '1to1',
    games: [{ gameCode: 'synthetic-game', name: 'Synthetic Game', category: 'slot', private: 'must-not-pass' }],
  });
};

const { sql,withStorage } = await import('./runtime.mjs');
const { newSession } = await import('./security.mjs');
const { server } = await import('./server.mjs');

await withStorage(async () => {
  const now = new Date().toISOString();
  for (const id of ['alpha', 'beta']) await sql.prepare('INSERT INTO brands(id,name,created_at) VALUES (?,?,?)').run(id, id, now);
  await sql.prepare('INSERT INTO portal_users VALUES (?,?,?,?,?,?,?,?)').run('member', 'member', 'member@example.test', 'synthetic-password-hash', 'customer', 1, 'synthetic-recovery-hash', now);
  await sql.prepare('INSERT INTO members(email,tenant_id,created_at) VALUES (?,?,?)').run('member@example.test', 'alpha', now);
});
const memberCookie = 'portal_session=' + await withStorage(() => newSession('member'));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const call = (path, cookie) => nativeFetch(base + path, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });

try {
  const anonymous = await call('/api/v1/sponsored-games?provider=jili');
  assert.equal(anonymous.status, 401);
  assert.equal(upstreamCalls, 0);

  const response = await call('/api/v1/sponsored-games?provider=jili', memberCookie);
  assert.equal(response.status, 200);
  assert(response.headers.get('cache-control')?.split(',').every(value => value.trim() === 'no-store'));
  const data = await response.json();
  assert.equal(data.tenantId, 'alpha');
  assert.equal(data.provider, 'jili');
  assert.equal(data.freeOnly, true);
  assert.equal(data.freeEligibilitySource, 'user_confirmed_sponsorship');
  assert.equal(data.launchEnabled, false);
  assert.equal(data.walletUsed, false);
  assert.equal(data.source.status, 'ready');
  assert.equal(data.source.environment, 'uat');
  assert.equal(data.source.scope, 'catalog_only');
  assert.deepEqual(data.games, [{ id: 'synthetic-game', name: 'Synthetic Game', category: 'slot', imageUrl: null, status: 'catalogued' }]);
  assert(!JSON.stringify(data).includes('must-not-pass'));
  assert.equal(upstreamCalls, 1);

  const crossTenant = await call('/api/v1/sponsored-games?provider=jili&tenant=beta', memberCookie);
  assert.equal(crossTenant.status, 403);
  assert.equal(upstreamCalls, 1);
  console.log('PASS: real local HTTP sponsored-games route rejects anonymous and cross-tenant access; authenticated member receives a read-only UAT catalogue with launch and wallet disabled. Synthetic upstream only.');
} finally {
  await new Promise(resolve => server.close(resolve));
  await sql.close();
  globalThis.fetch = nativeFetch;
  rmSync(directory, { recursive: true, force: true });
}
