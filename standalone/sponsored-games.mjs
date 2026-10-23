const providerRoutes = Object.freeze({
  megah5: '/providers/megah5/games',
  jili: '/providers/jili/games?account=1to1',
  '918kiss': '/providers/918kissh5/games?account=free',
});
export const SPONSORED_GAMES_GATEWAY_ORIGIN = 'https://master7-integration-gateway.onrender.com';

const json = (data, status = 200) => Response.json(data, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

class CatalogueReadError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function boundedInteger(value, fallback, minimum, maximum, name) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError(`Invalid ${name}`);
  }
  return result;
}

function gatewayConfiguration(env, allowedOrigin) {
  const raw = String(env.PORTAL_GAMES_GATEWAY_URL || '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname) || url.origin !== allowedOrigin) return null;
  const token = String(env.PORTAL_GAMES_GATEWAY_TOKEN || '').trim();
  if (token && (Buffer.byteLength(token) < 32 || Buffer.byteLength(token) > 1024 || /[\r\n]/.test(token))) return null;
  const environment = String(env.PORTAL_GAMES_GATEWAY_MODE || 'uat').trim().toLowerCase();
  if (!['uat', 'production'].includes(environment)) return null;
  return { origin: url.origin, token, environment };
}

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch { /* Discard untrusted upstream content. */ }
}

async function boundedJson(response, expectedUrl, maximumBytes) {
  if (response.redirected || (response.url && response.url !== expectedUrl)) {
    await cancelBody(response);
    throw new CatalogueReadError('GATEWAY_REDIRECT_BLOCKED');
  }
  if (response.status === 503) {
    await cancelBody(response);
    throw new CatalogueReadError('GATEWAY_NOT_CONFIGURED');
  }
  if (!response.ok) {
    await cancelBody(response);
    throw new CatalogueReadError('GATEWAY_HTTP_ERROR');
  }
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await cancelBody(response);
    throw new CatalogueReadError('GATEWAY_INVALID_CONTENT_TYPE');
  }
  const declared = response.headers.get('content-length');
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximumBytes) {
    await cancelBody(response);
    throw new CatalogueReadError('GATEWAY_RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new CatalogueReadError('GATEWAY_EMPTY_RESPONSE');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new CatalogueReadError('GATEWAY_RESPONSE_TOO_LARGE');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  if (!bytes) throw new CatalogueReadError('GATEWAY_EMPTY_RESPONSE');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CatalogueReadError('GATEWAY_INVALID_JSON'); }
}

function safeText(value, maximum) {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
  else if (typeof value !== 'string') return null;
  const result = value.trim();
  return result && result.length <= maximum && !/[\u0000-\u001f\u007f]/.test(result) ? result : null;
}

function safeImage(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function rawGames(provider, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CatalogueReadError('GATEWAY_INVALID_RESPONSE');
  if (provider === 'megah5') {
    if (data.provider !== 'megah5' || Number(data.result?.Status) !== 200 || !Array.isArray(data.result?.Game)) throw new CatalogueReadError('GATEWAY_INVALID_RESPONSE');
    return data.result.Game.map(game => ({
      id: game?.GameCode,
      name: game?.GameName,
      category: game?.GameType,
      imageUrl: game?.ImageUrl,
      maintenance: game?.IsMaintenance === true || Number(game?.IsMaintenance) === 1,
    }));
  }
  const expected = provider === '918kiss' ? '918kissh5' : 'jili';
  if (data.provider !== expected || !Array.isArray(data.games)) throw new CatalogueReadError('GATEWAY_INVALID_RESPONSE');
  if (provider === '918kiss' && data.account !== 'free') throw new CatalogueReadError('GATEWAY_INVALID_RESPONSE');
  if (provider === 'jili' && data.account !== '1to1') throw new CatalogueReadError('GATEWAY_INVALID_RESPONSE');
  return data.games.map(game => ({
    id: game?.gameCode,
    name: game?.name || game?.nameZh,
    category: game?.category,
    imageUrl: game?.imageUrl,
    maintenance: game?.maintenance === true,
  }));
}

function projectGames(provider, data, maximumGames) {
  const input = rawGames(provider, data);
  const games = [];
  const seen = new Set();
  for (const item of input) {
    if (games.length >= maximumGames) break;
    const id = safeText(item.id, 128), name = safeText(item.name, 300);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    games.push({
      id,
      name,
      category: safeText(item.category, 80) || 'other',
      imageUrl: safeImage(item.imageUrl),
      status: item.maintenance ? 'maintenance' : 'catalogued',
    });
  }
  if (input.length && !games.length) throw new CatalogueReadError('GATEWAY_INVALID_GAME_LIST');
  return { games, truncated: input.length > maximumGames };
}

/**
 * Reads a public game catalogue through a server-owned integration gateway.
 * This handler cannot launch a game, create a provider player, debit a wallet,
 * or receive a wager. Caller-controlled URLs and credentials are never used.
 */
export function createSponsoredGamesHandler({
  getMemberTenant,
  tenantExists,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs,
  maxResponseBytes,
  maxGames,
  cacheMs,
  pendingCacheMs,
  errorCacheMs,
  allowedGatewayOrigin = SPONSORED_GAMES_GATEWAY_ORIGIN,
} = {}) {
  if (typeof getMemberTenant !== 'function' || typeof tenantExists !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function') {
    throw new TypeError('Sponsored games handler requires trusted storage callbacks');
  }
  const timeout = boundedInteger(timeoutMs, 5000, 1, 15000, 'catalogue timeout');
  const maximumBytes = boundedInteger(maxResponseBytes, 4 * 1024 * 1024, 1024, 5 * 1024 * 1024, 'catalogue response limit');
  const maximumGames = boundedInteger(maxGames, 1000, 1, 2000, 'catalogue game limit');
  const healthyCache = boundedInteger(cacheMs, 15000, 0, 30000, 'catalogue cache duration');
  const pendingCache = boundedInteger(pendingCacheMs, 5000, 0, 5000, 'pending catalogue cache duration');
  const failedCache = boundedInteger(errorCacheMs, 2000, 0, 3000, 'failed catalogue cache duration');
  let trustedGateway;
  try { trustedGateway = new URL(allowedGatewayOrigin); } catch { throw new TypeError('Invalid sponsored games gateway origin'); }
  if (trustedGateway.protocol !== 'https:' || trustedGateway.username || trustedGateway.password || trustedGateway.search || trustedGateway.hash || !['', '/'].includes(trustedGateway.pathname) || trustedGateway.origin !== allowedGatewayOrigin.replace(/\/$/, '')) {
    throw new TypeError('Invalid sponsored games gateway origin');
  }
  const trustedGatewayOrigin = trustedGateway.origin;
  // Provider catalogues contain no member or tenant data. Keeping this cache
  // outside the request scope lets all tenants share only the same public list.
  const cache = new Map(), inFlight = new Map();

  async function scope(user, selectedTenant) {
    if (!user) return { error: json({ error: '请先登录' }, 401) };
    if (!['owner', 'tenant_owner', 'employee', 'customer'].includes(user.role)) return { error: json({ error: '当前账号没有游戏目录权限' }, 403) };
    if (selectedTenant !== null && (typeof selectedTenant !== 'string' || selectedTenant.length > 60)) return { error: json({ error: '租户标识无效' }, 400) };
    if (['tenant_owner', 'employee'].includes(user.role) && !user.tenantId) return { error: json({ error: '租户归属无效' }, 403) };
    try {
      const memberTenant = user.role === 'customer' && !user.tenantId ? await getMemberTenant(user.email) : null;
      const bound = user.tenantId || memberTenant || 'main';
      if (user.role !== 'owner' && selectedTenant && selectedTenant !== bound) return { error: json({ error: '无权访问其他租户' }, 403) };
      const tenantId = user.role === 'owner' ? (selectedTenant || 'main') : bound;
      if (tenantId !== 'main' && !await tenantExists(tenantId)) return { error: json({ error: '租户不存在' }, 404) };
      return { tenantId };
    } catch { return { error: json({ error: '资料暂时无法读取，请稍后重试。' }, 503) }; }
  }

  async function readFresh(provider) {
    const checkedAt = new Date(now()).toISOString();
    const config = gatewayConfiguration(env, trustedGatewayOrigin);
    if (!config) return { games: [], source: { status: 'pending', checkedAt, environment: 'uat', scope: 'catalog_only' } };
    const target = config.origin + providerRoutes[provider];
    const controller = new AbortController();
    let timer;
    try {
      const request = (async () => {
        const headers = { Accept: 'application/json' };
        if (config.token) headers.Authorization = 'Bearer ' + config.token;
        const response = await fetchImpl(target, { method: 'GET', redirect: 'error', headers, signal: controller.signal });
        const result = projectGames(provider, await boundedJson(response, target, maximumBytes), maximumGames);
        return { games: result.games, source: { status: 'ready', checkedAt, environment: config.environment, scope: 'catalog_only', ...(result.truncated ? { truncated: true } : {}) } };
      })();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new CatalogueReadError('GATEWAY_TIMEOUT')); }, timeout);
      });
      return await Promise.race([request, deadline]);
    } catch (error) {
      const pending = error instanceof CatalogueReadError && error.code === 'GATEWAY_NOT_CONFIGURED';
      return { games: [], source: { status: pending ? 'pending' : 'error', checkedAt, environment: config.environment, scope: 'catalog_only' } };
    } finally { clearTimeout(timer); }
  }

  async function read(provider) {
    const current = Number(now());
    if (!Number.isFinite(current)) throw new TypeError('Invalid catalogue clock');
    const cached = cache.get(provider);
    if (cached && current < cached.expiresAt) return cached.value;
    if (inFlight.has(provider)) return inFlight.get(provider);
    const request = (async () => {
      const value = await readFresh(provider);
      const duration = value.source.status === 'ready' ? healthyCache : value.source.status === 'pending' ? pendingCache : failedCache;
      cache.set(provider, { value, expiresAt: Number(now()) + duration });
      return value;
    })();
    inFlight.set(provider, request);
    try { return await request; }
    finally { if (inFlight.get(provider) === request) inFlight.delete(provider); }
  }

  return async function getSponsoredGames(user, params) {
    const provider = params?.get?.('provider') || '';
    if (!Object.hasOwn(providerRoutes, provider)) return json({ error: '赞助商标识无效' }, 400);
    const selectedTenant = params.has('tenant') ? params.get('tenant') : null;
    const access = await scope(user, selectedTenant);
    if (access.error) return access.error;
    const result = await read(provider);
    return json({ tenantId: access.tenantId, provider, freeOnly: true, freeEligibilitySource: 'user_confirmed_sponsorship', launchEnabled: false, walletUsed: false, ...result });
  };
}
