// Reports public gateway readiness only. This module cannot create orders,
// credit wallets, issue refunds, or enable a payment channel.
export const GATEWAY_STATUS_URL = 'https://master7-integration-gateway.onrender.com/providers/vpay/status';

class StatusReadError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const json = (data, status = 200) => Response.json(data, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

const channels = () => [
  { id: 'vpay', label: 'VPay', currency: 'MYR' },
  { id: 'gspay_myr', label: 'GSPAY+ MYR', currency: 'MYR' },
  { id: 'gspay_usdt', label: 'GSPAY+ USDT', currency: 'USDT' },
].map(channel => ({ ...channel, enabled: false, status: 'not_open', message: '暂未开放' }));

function limit(value, fallback, minimum, maximum) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new TypeError('Invalid payment status reader limits');
  }
  return result;
}

async function cancelBody(response) {
  try { await response.body?.cancel(); } catch { /* No upstream error text is retained. */ }
}

async function boundedJson(response, maximumBytes) {
  if (response.redirected) {
    await cancelBody(response);
    throw new StatusReadError('GATEWAY_REDIRECT_BLOCKED');
  }
  if (!response.ok) {
    await cancelBody(response);
    throw new StatusReadError('GATEWAY_HTTP_ERROR');
  }
  if (response.url && response.url !== GATEWAY_STATUS_URL) {
    await cancelBody(response);
    throw new StatusReadError('GATEWAY_REDIRECT_BLOCKED');
  }
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await cancelBody(response);
    throw new StatusReadError('GATEWAY_INVALID_CONTENT_TYPE');
  }
  const declaredLength = response.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maximumBytes) {
    await cancelBody(response);
    throw new StatusReadError('GATEWAY_RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new StatusReadError('GATEWAY_EMPTY_RESPONSE');
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new StatusReadError('GATEWAY_RESPONSE_TOO_LARGE');
      }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  if (!bytes) throw new StatusReadError('GATEWAY_EMPTY_RESPONSE');
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new StatusReadError('GATEWAY_INVALID_JSON'); }
}

function normalizeGateway(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.provider !== 'vpay') {
    throw new StatusReadError('GATEWAY_INVALID_RESPONSE');
  }
  const payment = data.readiness?.channels?.payment;
  const boolean = value => typeof value === 'boolean' ? value : null;
  return {
    reachable: true,
    mode: ['uat', 'production'].includes(data.mode) ? data.mode : 'unknown',
    configured: boolean(data.configured),
    configurationReady: boolean(payment?.configurationReady),
    liveReady: boolean(payment?.liveReady),
    version: typeof data.version === 'string' && /^v?\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-z0-9.-]{1,24})?$/i.test(data.version) ? data.version : null,
    errorCode: null,
  };
}

/**
 * Storage callbacks must resolve only server-owned membership data. They may
 * wrap short queries in withStorage; gateway fetching happens after they finish.
 * The user argument must come from the portal's verified session, never JSON.
 */
export function createPaymentChannelsHandler({
  getMemberTenant,
  tenantExists,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs,
  maxResponseBytes,
  cacheMs,
} = {}) {
  if (typeof getMemberTenant !== 'function' || typeof tenantExists !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function') {
    throw new TypeError('Payment channel handler requires trusted storage callbacks');
  }
  const timeout = limit(timeoutMs, 3000, 1, 10000);
  const maximumBytes = limit(maxResponseBytes, 65536, 1, 262144);
  const cacheDuration = limit(cacheMs, 15000, 0, 30000);
  let cached = null, expiresAt = 0, inFlight = null;

  async function readGateway() {
    const controller = new AbortController();
    let timer;
    try {
      const request = (async () => {
        const response = await fetchImpl(GATEWAY_STATUS_URL, {
          method: 'GET',
          redirect: 'error',
          headers: { Accept: 'application/json' },
          signal: controller.signal,
        });
        return normalizeGateway(await boundedJson(response, maximumBytes));
      })();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new StatusReadError('GATEWAY_TIMEOUT'));
        }, timeout);
      });
      return await Promise.race([request, deadline]);
    } catch (error) {
      return {
        reachable: false, mode: 'unknown', configured: null,
        configurationReady: null, liveReady: null, version: null,
        errorCode: controller.signal.aborted ? 'GATEWAY_TIMEOUT' : error instanceof StatusReadError ? error.code : 'GATEWAY_UNAVAILABLE',
      };
    } finally { clearTimeout(timer); }
  }

  async function status() {
    if (cached && now() < expiresAt) return cached;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const gateway = await readGateway();
      cached = { checkedAt: new Date(now()).toISOString(), gateway };
      // Do not preserve an earlier healthy snapshot after a failed refresh.
      expiresAt = now() + (gateway.reachable ? cacheDuration : Math.min(cacheDuration, 3000));
      return cached;
    })();
    try { return await inFlight; }
    finally { inFlight = null; }
  }

  return async function getPaymentChannels(user, selectedTenant = null) {
    if (!user) return json({ error: '请先登录' }, 401);
    if (!['owner', 'tenant_owner', 'customer'].includes(user.role)) {
      return json({ error: '当前账号没有支付通道资料权限' }, 403);
    }
    if (selectedTenant !== null && (typeof selectedTenant !== 'string' || selectedTenant.length > 60)) {
      return json({ error: '租户标识无效' }, 400);
    }
    if (user.role === 'tenant_owner' && !user.tenantId) {
      return json({ error: '租户归属无效' }, 403);
    }
    let tenantId;
    try {
      const memberTenant = user.role === 'customer' && !user.tenantId ? await getMemberTenant(user.email) : null;
      const bound = user.tenantId || memberTenant || 'main';
      if (user.role !== 'owner' && selectedTenant && selectedTenant !== bound) {
        return json({ error: '无权访问其他租户' }, 403);
      }
      tenantId = user.role === 'owner' ? (selectedTenant || 'main') : bound;
      if (tenantId !== 'main' && !await tenantExists(tenantId)) return json({ error: '租户不存在' }, 404);
    } catch { return json({ error: '资料暂时无法读取，请稍后重试。' }, 503); }

    const source = await status();
    const result = { tenantId, channels: channels(), fundsProcessed: false };
    if (user.role === 'owner') {
      result.diagnostics = {
        ...source,
        limitations: {
          vpay: 'checkout_disabled_until_production_qa',
          gspay_myr: 'adapter_not_implemented',
          gspay_usdt: 'new_orders_stopped',
        },
      };
    }
    return json(result);
  };
}
