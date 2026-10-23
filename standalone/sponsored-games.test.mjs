import test from 'node:test';
import assert from 'node:assert/strict';
import { createSponsoredGamesHandler } from './sponsored-games.mjs';

const owner = { userId: 'owner', role: 'owner', email: 'owner@example.test' };
const customer = { userId: 'member', role: 'customer', email: 'member@example.test' };
const employee = { userId: 'staff', role: 'employee', tenantId: 'alpha', email: 'staff@example.test' };
const baseEnv = { PORTAL_GAMES_GATEWAY_URL: 'https://gateway.example.test', PORTAL_GAMES_GATEWAY_TOKEN: 'synthetic-token-that-is-at-least-32-bytes' };
const makeResponse = (data, init = {}) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' }, ...init });
const params = value => new URLSearchParams(value);
const handler = (options = {}) => createSponsoredGamesHandler({
  getMemberTenant: async () => 'alpha',
  tenantExists: async id => ['alpha', 'beta'].includes(id),
  env: baseEnv,
  fetchImpl: async () => makeResponse({ provider: 'jili', account: '1to1', games: [] }),
  now: () => Date.parse('2026-10-23T12:00:00.000Z'),
  allowedGatewayOrigin: 'https://gateway.example.test',
  ...options,
});
test('authentication, roles, provider allowlist and tenant isolation run before the gateway request', async () => {
  let calls = 0;
  const get = handler({ fetchImpl: async () => { calls++; return makeResponse({}); } });
  assert.equal((await get(null, params('provider=jili'))).status, 401);
  assert.equal((await get({ ...customer, role: 'unknown' }, params('provider=jili'))).status, 403);
  assert.equal((await get(customer, params('provider=unknown'))).status, 400);
  assert.equal((await get(customer, params('provider=jili&tenant=beta'))).status, 403);
  assert.equal((await get({ ...employee, tenantId: null }, params('provider=jili'))).status, 403);
  assert.equal((await get(owner, params('provider=jili&tenant=missing'))).status, 404);
  assert.equal(calls, 0);
});

test('customer, employee and headquarters receive only their allowed tenant scope', async () => {
  const get = handler();
  assert.equal((await (await get(customer, params('provider=jili'))).json()).tenantId, 'alpha');
  assert.equal((await (await get(employee, params('provider=jili'))).json()).tenantId, 'alpha');
  assert.equal((await (await get(owner, params('provider=jili&tenant=beta'))).json()).tenantId, 'beta');
});

test('missing or invalid server configuration returns a pending empty catalogue without fetching', async () => {
  for (const env of [{}, { PORTAL_GAMES_GATEWAY_URL: 'http://gateway.example.test' }, { PORTAL_GAMES_GATEWAY_URL: 'https://user:pass@gateway.example.test' }, { PORTAL_GAMES_GATEWAY_URL: 'https://attacker.example.test' }, { PORTAL_GAMES_GATEWAY_URL: 'https://gateway.example.test', PORTAL_GAMES_GATEWAY_TOKEN: 'short' }]) {
    let calls = 0;
    const get = handler({ env, fetchImpl: async () => { calls++; return makeResponse({}); } });
    const response = await get(customer, params('provider=megah5'));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.source.status, 'pending');
    assert.deepEqual(data.games, []);
    assert.equal(data.freeOnly, true);
    assert.equal(data.freeEligibilitySource, 'user_confirmed_sponsorship');
    assert.equal(data.launchEnabled, false);
    assert.equal(data.walletUsed, false);
    assert.equal(data.source.environment, 'uat');
    assert.equal(data.source.scope, 'catalog_only');
    assert.equal(calls, 0);
  }
});

test('the three fixed provider routes use only the server token and project safe catalogue fields', async () => {
  const expected = new Map([
    ['https://gateway.example.test/providers/megah5/games', { provider: 'megah5', upstreamStatus: 200, result: { Status: 200, Game: [
      { GameCode: 'mega-1', GameName: 'Mega One', GameType: 2, ImageUrl: 'https://images.example.test/mega.webp' },
      { GameCode: 'mega-1', GameName: 'Duplicate', GameType: 2 },
      { GameCode: 'bad', GameName: 'Bad Image', GameType: 3, ImageUrl: 'http://unsafe.example.test/x.png' },
    ] } }],
    ['https://gateway.example.test/providers/jili/games?account=1to1', { provider: 'jili', account: '1to1', games: [{ gameCode: 'jili-1', name: 'Jili One', category: 'slot', secret: 'must-not-pass' }] }],
    ['https://gateway.example.test/providers/918kissh5/games?account=free', { provider: '918kissh5', account: 'free', games: [{ gameCode: 'kiss-1', name: 'Kiss One', category: 'slot', imageUrl: 'https://images.example.test/kiss.png', maintenance: true }] }],
  ]);
  const seen = [];
  const get = handler({ fetchImpl: async (url, options) => {
    seen.push(url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/json', Authorization: 'Bearer synthetic-token-that-is-at-least-32-bytes' });
    assert(options.signal instanceof AbortSignal);
    return makeResponse(expected.get(url));
  } });
  const results = {};
  for (const provider of ['megah5', 'jili', '918kiss']) results[provider] = await (await get({ ...customer, token: 'caller-token', url: 'https://attacker.test' }, params({ provider }))).json();
  assert.deepEqual(seen, [...expected.keys()]);
  assert.deepEqual(results.megah5.games, [
    { id: 'mega-1', name: 'Mega One', category: '2', imageUrl: 'https://images.example.test/mega.webp', status: 'catalogued' },
    { id: 'bad', name: 'Bad Image', category: '3', imageUrl: null, status: 'catalogued' },
  ]);
  assert.deepEqual(results.jili.games, [{ id: 'jili-1', name: 'Jili One', category: 'slot', imageUrl: null, status: 'catalogued' }]);
  assert.equal(results['918kiss'].games[0].status, 'maintenance');
  assert.equal(results.jili.source.status, 'ready');
  assert.equal(results.jili.source.environment, 'uat');
  assert.equal(results.jili.source.scope, 'catalog_only');
  assert.equal(results.jili.launchEnabled, false);
  assert.equal(results.jili.walletUsed, false);
  assert.equal(results.jili.freeEligibilitySource, 'user_confirmed_sponsorship');
  assert(!JSON.stringify(results).includes('must-not-pass'));
  assert(!JSON.stringify(results).includes('caller-token'));
});

test('a public gateway can be read without inventing an Authorization header', async () => {
  const get = handler({
    env: { PORTAL_GAMES_GATEWAY_URL: 'https://gateway.example.test/' },
    fetchImpl: async (_url, options) => {
      assert.deepEqual(options.headers, { Accept: 'application/json' });
      return makeResponse({ provider: 'jili', account: '1to1', games: [] });
    },
  });
  assert.equal((await (await get(customer, params('provider=jili'))).json()).source.status, 'ready');
});

test('production is only reported when the deployment explicitly configures it', async () => {
  const get = handler({
    env: { PORTAL_GAMES_GATEWAY_URL: 'https://gateway.example.test', PORTAL_GAMES_GATEWAY_MODE: 'production' },
    fetchImpl: async () => makeResponse({ provider: 'jili', account: '1to1', games: [] }),
  });
  const data = await (await get(customer, params('provider=jili'))).json();
  assert.equal(data.source.environment, 'production');
  assert.equal(data.launchEnabled, false);
});

test('provider not configured stays pending while malformed, failed and secret-bearing errors fail closed', async () => {
  const cases = [
    [async () => makeResponse({ error: 'not configured' }, { status: 503 }), 'pending'],
    [async () => makeResponse({ provider: 'wrong', private: 'do-not-return' }), 'error'],
    [async () => new Response('<html>secret</html>', { headers: { 'Content-Type': 'text/html' } }), 'error'],
    [async () => { throw Error('secret-url-and-token'); }, 'error'],
  ];
  for (const [fetchImpl, status] of cases) {
    const data = await (await handler({ fetchImpl })(customer, params('provider=jili'))).json();
    assert.equal(data.source.status, status);
    assert.deepEqual(data.games, []);
    assert(!JSON.stringify(data).includes('secret'));
    assert(!JSON.stringify(data).includes('do-not-return'));
  }
});

test('timeout, redirects and both declared and streamed oversized bodies fail closed', async () => {
  const never = handler({ timeoutMs: 10, fetchImpl: async (_url, options) => {
    options.signal.addEventListener('abort', () => {});
    return new Promise(() => {});
  } });
  assert.equal((await (await never(customer, params('provider=jili'))).json()).source.status, 'error');

  const redirected = handler({ fetchImpl: async () => {
    const response = makeResponse({ provider: 'jili', account: '1to1', games: [] });
    Object.defineProperty(response, 'redirected', { value: true });
    return response;
  } });
  assert.equal((await (await redirected(customer, params('provider=jili'))).json()).source.status, 'error');

  for (const headers of [
    { 'Content-Type': 'application/json', 'Content-Length': '10000' },
    { 'Content-Type': 'application/json' },
  ]) {
    const oversized = handler({ maxResponseBytes: 1024, fetchImpl: async () => new Response('x'.repeat(10000), { headers }) });
    assert.equal((await (await oversized(customer, params('provider=jili'))).json()).source.status, 'error');
  }
});

test('catalogue size is capped and reported without exposing discarded games', async () => {
  const games = Array.from({ length: 4 }, (_, index) => ({ gameCode: `game-${index}`, name: `Game ${index}`, category: 'slot' }));
  const get = handler({ maxGames: 2, fetchImpl: async () => makeResponse({ provider: 'jili', account: '1to1', games }) });
  const data = await (await get(customer, params('provider=jili'))).json();
  assert.equal(data.games.length, 2);
  assert.equal(data.source.truncated, true);
});

test('concurrent requests share one upstream read per provider while providers remain isolated', async () => {
  let calls = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const get = handler({ fetchImpl: async url => {
    calls++;
    await gate;
    if (url.includes('/megah5/')) return makeResponse({ provider: 'megah5', result: { Status: 200, Game: [] } });
    if (url.includes('/918kissh5/')) return makeResponse({ provider: '918kissh5', account: 'free', games: [] });
    return makeResponse({ provider: 'jili', account: '1to1', games: [] });
  } });
  const requests = [
    get(customer, params('provider=jili')),
    get(employee, params('provider=jili')),
    get(owner, params('provider=jili&tenant=beta')),
    get(customer, params('provider=megah5')),
    get(customer, params('provider=918kiss')),
  ];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 3);
  release();
  const results = await Promise.all(requests);
  assert(results.every(result => result.status === 200));
  assert.equal(calls, 3);
});

test('healthy cache lasts 15 seconds, an expired failure replaces it, and errors retry after two seconds', async () => {
  let clock = Date.parse('2026-10-23T12:00:00.000Z'), calls = 0, fail = false;
  const get = handler({ now: () => clock, fetchImpl: async () => {
    calls++;
    if (fail) throw Error('private-upstream-failure');
    return makeResponse({ provider: 'jili', account: '1to1', games: [{ gameCode: 'one', name: 'One', category: 'slot' }] });
  } });
  const first = await (await get(customer, params('provider=jili'))).json();
  assert.equal(first.source.status, 'ready');
  assert.equal(calls, 1);
  clock += 14999;
  const cached = await (await get(employee, params('provider=jili'))).json();
  assert.equal(calls, 1);
  assert.equal(cached.source.checkedAt, first.source.checkedAt);
  clock += 2;
  fail = true;
  const failed = await (await get(customer, params('provider=jili'))).json();
  assert.equal(calls, 2);
  assert.equal(failed.source.status, 'error');
  assert.deepEqual(failed.games, []);
  assert.notEqual(failed.source.checkedAt, first.source.checkedAt);
  await get(customer, params('provider=jili'));
  assert.equal(calls, 2);
  clock += 2001;
  fail = false;
  const recovered = await (await get(customer, params('provider=jili'))).json();
  assert.equal(calls, 3);
  assert.equal(recovered.source.status, 'ready');
  assert.equal(recovered.games.length, 1);
});

test('pending configuration is cached for only five seconds before configuration is re-read', async () => {
  let clock = Date.parse('2026-10-23T12:00:00.000Z'), calls = 0;
  const env = {};
  const get = handler({ env, now: () => clock, fetchImpl: async () => {
    calls++;
    return makeResponse({ provider: 'jili', account: '1to1', games: [] });
  } });
  const pending = await (await get(customer, params('provider=jili'))).json();
  assert.equal(pending.source.status, 'pending');
  assert.equal(calls, 0);
  env.PORTAL_GAMES_GATEWAY_URL = 'https://gateway.example.test';
  clock += 4999;
  assert.equal((await (await get(customer, params('provider=jili'))).json()).source.status, 'pending');
  assert.equal(calls, 0);
  clock += 2;
  const ready = await (await get(customer, params('provider=jili'))).json();
  assert.equal(ready.source.status, 'ready');
  assert.equal(calls, 1);
  assert.notEqual(ready.source.checkedAt, pending.source.checkedAt);
});
