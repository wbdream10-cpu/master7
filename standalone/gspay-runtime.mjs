import { timingSafeEqual } from 'node:crypto';

export const GSPAY_CALLBACK_MAX_BYTES = 16 * 1024;
export const GSPAY_SETTLEMENT_DISABLED = 'GSPAY_SETTLEMENT_DISABLED';

const json = (data, status = 200) => Response.json(data, {
  status,
  headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

function validToken(value) {
  return typeof value === 'string'
    && Buffer.byteLength(value) >= 32
    && Buffer.byteLength(value) <= 1024
    && /^[\x21-\x7e]+$/.test(value);
}

function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const actual = Buffer.from(left);
  const expected = Buffer.from(right);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function callbackTokenState(env) {
  const token = env.PORTAL_GSPAY_CALLBACK_TOKEN;
  if (!validToken(token)) return { ready: false, token: null };
  const forbiddenNames = new Set([
    'PORTAL_VPAY_CALLBACK_TOKEN',
    'PORTAL_VPAY_QUERY_TOKEN',
    'PORTAL_VPAY_ORDER_TOKEN',
    'PORTAL_GAMES_GATEWAY_TOKEN',
    'PORTAL_OWNER_BOOTSTRAP_TOKEN_SHA256',
    'PORTAL_GSPAY_OPERATOR_AUTHENTICATION_KEY',
    'PORTAL_GSPAY_OPERATOR_SECRET_KEY',
  ]);
  for (const name of Object.keys(env)) if (name.startsWith('PORTAL_HOOK_')) forbiddenNames.add(name);
  for (const name of forbiddenNames) {
    const other = env[name];
    if (typeof other === 'string' && other.length && sameSecret(token, other)) return { ready: false, token: null };
  }
  return { ready: true, token };
}

function contentTypeIsJson(value) {
  return String(value || '').split(';')[0].trim().toLowerCase() === 'application/json';
}

function statusBody(tenantId) {
  return {
    tenantId,
    provider: 'gspay_myr',
    currency: 'MYR',
    enabled: false,
    ordersEnabled: false,
    callbacksEnabled: false,
    settlementEnabled: false,
    liveReady: false,
    mode: 'disabled',
    blockers: [GSPAY_SETTLEMENT_DISABLED],
  };
}

/**
 * This is a deliberately closed gateway-to-portal boundary. It has no supplier
 * transport or storage dependency, and cannot acknowledge or settle a payment.
 */
export function createGSPayRuntime({
  env = process.env,
  getMemberTenant,
  tenantExists,
} = {}) {
  if (typeof getMemberTenant !== 'function' || typeof tenantExists !== 'function') {
    throw new TypeError('GSPAY runtime requires trusted tenant lookup callbacks');
  }
  const callback = callbackTokenState(env);

  async function status(user, selectedTenant = null) {
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
    try {
      const memberTenant = user.role === 'customer' && !user.tenantId ? await getMemberTenant(user.email) : null;
      const bound = user.tenantId || memberTenant || 'main';
      if (user.role !== 'owner' && selectedTenant && selectedTenant !== bound) {
        return json({ error: '无权访问其他租户' }, 403);
      }
      const tenantId = user.role === 'owner' ? (selectedTenant || 'main') : bound;
      if (tenantId !== 'main' && !await tenantExists(tenantId)) return json({ error: '租户不存在' }, 404);
      return json(statusBody(tenantId));
    } catch {
      return json({ error: '资料暂时无法读取，请稍后重试。' }, 503);
    }
  }

  function authenticate(authorization) {
    // A missing, weak, or reused server credential never opens this endpoint.
    if (!callback.ready) return json({ error: GSPAY_SETTLEMENT_DISABLED }, 503);
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
      return json({ error: 'GSPAY_CALLBACK_UNAUTHORIZED' }, 401);
    }
    const supplied = authorization.slice('Bearer '.length);
    if (!validToken(supplied) || !sameSecret(supplied, callback.token)) {
      return json({ error: 'GSPAY_CALLBACK_UNAUTHORIZED' }, 401);
    }
    return null;
  }

  async function receive({ authorization, contentType, readBody, channel = 'payment' } = {}) {
    const authFailure = authenticate(authorization);
    if (authFailure) return authFailure;
    if (!contentTypeIsJson(contentType)) return json({ error: 'GSPAY_CALLBACK_JSON_REQUIRED' }, 415);
    if (!['payment', 'duitnow'].includes(channel) || typeof readBody !== 'function') {
      return json({ error: 'GSPAY_CALLBACK_INVALID_REQUEST' }, 400);
    }
    let body;
    try { body = await readBody(); }
    catch (error) {
      if (error?.message === 'TOO_LARGE' || error?.code === 'GSPAY_CALLBACK_TOO_LARGE') {
        return json({ error: 'GSPAY_CALLBACK_TOO_LARGE' }, 413);
      }
      throw error;
    }
    if (!Buffer.isBuffer(body)) body = Buffer.from(body || '');
    if (body.byteLength > GSPAY_CALLBACK_MAX_BYTES) return json({ error: 'GSPAY_CALLBACK_TOO_LARGE' }, 413);
    let payload;
    try { payload = JSON.parse(body.toString('utf8')); }
    catch { return json({ error: 'GSPAY_CALLBACK_INVALID_JSON' }, 400); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return json({ error: 'GSPAY_CALLBACK_INVALID_JSON' }, 400);
    }
    // Do not retain, query, verify, acknowledge, or act on any supplied field.
    return json({ error: GSPAY_SETTLEMENT_DISABLED }, 503);
  }

  return { status, receive };
}
