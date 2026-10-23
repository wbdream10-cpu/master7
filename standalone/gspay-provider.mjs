import { normalizeGSPayMYR } from './gspay-contract.mjs';

export const GSPAY_GATEWAY_ORIGIN = 'https://master7-integration-gateway.onrender.com';
export const GSPAY_GATEWAY_QUERY_CONTRACT = 'gspay-myr-query-v1';
export const GSPAY_GATEWAY_RESPONSE_MAX_BYTES = 64 * 1024;

const DEFAULT_TIMEOUT_MS = 8_000;
const tokenPattern = /^[\x21-\x7e]+$/;
const transactionPattern = /^[A-Za-z0-9_-]{8,100}$/;
const playerPattern = /^[a-z0-9_-]{3,40}$/;
const paymentIdPattern = /^[1-9]\d{0,39}$/;

export class GSPayProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GSPayProviderError';
    this.code = code;
  }
}

const fail = code => { throw new GSPayProviderError(code); };

function record(value, code = 'GSPAY_GATEWAY_INVALID_RESPONSE') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

function exactKeys(value, keys) {
  const actual = Object.keys(record(value)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('GSPAY_GATEWAY_INVALID_RESPONSE');
  }
}

function validToken(value) {
  return typeof value === 'string' && Buffer.byteLength(value) >= 32 &&
    Buffer.byteLength(value) <= 1024 && tokenPattern.test(value);
}

function credentialState(env) {
  const orderToken = env.PORTAL_GSPAY_ORDER_TOKEN;
  const queryToken = env.PORTAL_GSPAY_QUERY_TOKEN;
  if (!validToken(orderToken) || !validToken(queryToken) || orderToken === queryToken) return null;
  const reserved = new Set([
    'PORTAL_GSPAY_CALLBACK_TOKEN',
    'PORTAL_VPAY_CALLBACK_TOKEN',
    'PORTAL_VPAY_QUERY_TOKEN',
    'PORTAL_VPAY_ORDER_TOKEN',
    'PORTAL_GAMES_GATEWAY_TOKEN',
  ]);
  for (const name of Object.keys(env)) if (name.startsWith('PORTAL_HOOK_')) reserved.add(name);
  for (const name of reserved) {
    const value = env[name];
    if (typeof value === 'string' && value.length && (value === orderToken || value === queryToken)) return null;
  }
  return { orderToken, queryToken };
}

function expectedOrder(value) {
  record(value, 'GSPAY_INVALID_ORDER');
  if (value.currency !== 'MYR' || typeof value.transactionId !== 'string' ||
      !transactionPattern.test(value.transactionId) || typeof value.playerUsername !== 'string' ||
      !playerPattern.test(value.playerUsername) ||
      (value.paymentId !== undefined && (typeof value.paymentId !== 'string' ||
        !paymentIdPattern.test(value.paymentId)))) fail('GSPAY_INVALID_ORDER');
  let amount;
  try { amount = normalizeGSPayMYR(value.amount); }
  catch { fail('GSPAY_INVALID_ORDER'); }
  return Object.freeze({
    transactionId: value.transactionId,
    paymentId: value.paymentId ?? null,
    playerUsername: value.playerUsername,
    ...amount,
  });
}

function contentTypeIsJson(headers) {
  return String(headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase() === 'application/json';
}

async function readLimitedJson(response) {
  if (!response || response.status !== 200 || response.redirected || !contentTypeIsJson(response.headers)) {
    fail('GSPAY_GATEWAY_UNAVAILABLE');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > GSPAY_GATEWAY_RESPONSE_MAX_BYTES) {
    fail('GSPAY_GATEWAY_UNAVAILABLE');
  }
  let size = 0;
  const chunks = [];
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > GSPAY_GATEWAY_RESPONSE_MAX_BYTES) fail('GSPAY_GATEWAY_UNAVAILABLE');
      chunks.push(Buffer.from(chunk));
    }
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('GSPAY_GATEWAY_INVALID_RESPONSE'); }
  return record(parsed);
}

function validateConfiguration(value, environment) {
  record(value);
  if (value.provider !== 'gspay' || value.currency !== 'MYR' || value.mode !== environment ||
      value.providerBase !== 'https://api.thegspay.com' || value.transactionRoutesActive !== true ||
      value.queryReady !== true) fail('GSPAY_QUERY_CONTRACT_UNCONFIRMED');
  return Object.freeze({
    provider: 'gspay_myr',
    environment,
    queryReady: true,
    orderReady: value.orderReady === true,
    callbacksReady: value.callbacksReady === true,
    liveReady: false,
  });
}

function validateQueryResult(value, expected) {
  exactKeys(value, ['provider', 'contract', 'upstreamStatus', 'result']);
  if (value.provider !== 'gspay_myr' || value.contract !== GSPAY_GATEWAY_QUERY_CONTRACT ||
      value.upstreamStatus !== 200) fail('GSPAY_GATEWAY_INVALID_RESPONSE');
  const result = record(value.result);
  exactKeys(result, [
    'transactionId', 'paymentId', 'playerUsername', 'currency', 'amount', 'amountMinor',
    'completed', 'success', 'providerState', 'signatureVerified', 'settlementStatus',
    'fundsProcessed',
  ]);
  if (typeof result.transactionId !== 'string' || result.transactionId !== expected.transactionId ||
      typeof result.paymentId !== 'string' || !paymentIdPattern.test(result.paymentId) ||
      (expected.paymentId && result.paymentId !== expected.paymentId) ||
      result.playerUsername !== expected.playerUsername || result.currency !== 'MYR' ||
      result.amount !== expected.amount || result.amountMinor !== expected.amountMinor ||
      typeof result.completed !== 'boolean' || typeof result.success !== 'boolean' ||
      result.signatureVerified !== true || result.fundsProcessed !== false) {
    fail('GSPAY_GATEWAY_INVALID_RESPONSE');
  }
  if (!result.completed && result.success) fail('GSPAY_GATEWAY_INVALID_RESPONSE');
  const state = !result.completed ? 'pending' : result.success ? 'paid' : 'failed';
  if (result.providerState !== state ||
      result.settlementStatus !== (state === 'paid' ? 'query_confirmed' : 'not_payable')) {
    fail('GSPAY_GATEWAY_INVALID_RESPONSE');
  }
  return Object.freeze({
    provider: 'gspay_myr',
    contract: GSPAY_GATEWAY_QUERY_CONTRACT,
    source: 'gateway_query',
    gatewayAuthenticated: true,
    transactionId: result.transactionId,
    paymentId: result.paymentId,
    playerUsername: result.playerUsername,
    currency: 'MYR',
    amount: result.amount,
    amountMinor: result.amountMinor,
    completed: result.completed,
    success: result.success,
    providerState: result.providerState,
    signatureVerified: true,
    settlementStatus: result.settlementStatus,
    fundsProcessed: false,
  });
}

/**
 * Portal-to-integration-gateway client. Supplier credentials and URLs never
 * enter this process. Order creation stays hard closed until the gateway has a
 * confirmed supplier response contract. Querying requires the gateway to
 * advertise an explicit internal contract before a query request is sent.
 */
export function createGSPayMYRProvider({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const credentials = credentialState(env);
  const environment = ['uat', 'production'].includes(env.PORTAL_GSPAY_ENVIRONMENT)
    ? env.PORTAL_GSPAY_ENVIRONMENT : null;
  const configured = Boolean(credentials && environment && typeof fetchImpl === 'function');
  const boundedTimeout = Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 30_000
    ? timeoutMs : DEFAULT_TIMEOUT_MS;

  async function request(path, { token, method = 'GET', body } = {}) {
    if (!configured || !validToken(token)) fail('GSPAY_GATEWAY_UNAVAILABLE');
    const url = new URL(path, GSPAY_GATEWAY_ORIGIN);
    if (url.origin !== GSPAY_GATEWAY_ORIGIN || !path.startsWith('/')) fail('GSPAY_GATEWAY_UNAVAILABLE');
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new GSPayProviderError('GSPAY_GATEWAY_UNAVAILABLE'));
      }, boundedTimeout);
    });
    try {
      let response;
      try {
        response = await Promise.race([
          fetchImpl(url.href, {
            method,
            redirect: 'error',
            signal: controller.signal,
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${token}`,
              ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          timeout,
        ]);
      } catch (error) {
        if (error instanceof GSPayProviderError) throw error;
        fail('GSPAY_GATEWAY_UNAVAILABLE');
      }
      if (response.url) {
        let final;
        try { final = new URL(response.url); }
        catch { fail('GSPAY_GATEWAY_UNAVAILABLE'); }
        if (final.origin !== GSPAY_GATEWAY_ORIGIN) fail('GSPAY_GATEWAY_UNAVAILABLE');
      }
      return await readLimitedJson(response);
    } finally { clearTimeout(timer); }
  }

  async function configuration() {
    if (!configured) fail('GSPAY_GATEWAY_UNAVAILABLE');
    const value = await request('/platform/gspay/config', { token: credentials.queryToken });
    return validateConfiguration(value, environment);
  }

  async function createPayment(input) {
    // Validate locally so malformed requests fail consistently, but never read
    // configuration or call the gateway while the response schema is unknown.
    expectedOrder(input);
    fail('GSPAY_CREATE_SCHEMA_UNCONFIRMED');
  }

  async function queryPayment(input) {
    const expected = expectedOrder(input);
    await configuration();
    const response = await request('/platform/gspay/order-query', {
      token: credentials.queryToken,
      method: 'POST',
      body: {
        transactionId: expected.transactionId,
        paymentId: expected.paymentId,
        playerUsername: expected.playerUsername,
        amount: expected.amount,
        currency: 'MYR',
        contract: GSPAY_GATEWAY_QUERY_CONTRACT,
      },
    });
    return validateQueryResult(response, expected);
  }

  function status() {
    return Object.freeze({
      provider: 'gspay_myr',
      gatewayOrigin: GSPAY_GATEWAY_ORIGIN,
      environment,
      configured,
      contractVersionConfirmed: false,
      ordersReady: false,
      queryReady: false,
      callbacksReady: false,
      liveReady: false,
      fundsProcessed: false,
    });
  }

  return Object.freeze({ configuration, createPayment, queryPayment, status });
}
