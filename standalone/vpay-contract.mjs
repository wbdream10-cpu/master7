// Offline contract preparation only. No network, database, API keys or signing.
// Parsed provider claims are never authentication or permission to credit funds.
export const VPAY_DOCUMENTATION_URL = 'https://gateway.vpay.club/api/doc/trader_en';
const cashierOrigin = 'https://payment.vpay.club';
const tradeCodes = new Set(['1', '2', '3', '4', '5', '7']);
const controls = /[\u0000-\u001f\u007f-\u009f]/u;

export class VPayContractError extends Error {
  constructor(code) { super(code); this.name = 'VPayContractError'; this.code = code; }
}
const fail = code => { throw new VPayContractError(code); };
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('VPAY_INVALID_OBJECT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('VPAY_INVALID_OBJECT');
  return value;
}
function text(value, maximum, code) {
  if (typeof value !== 'string' || !value || value !== value.trim() || controls.test(value) || Buffer.byteLength(value, 'utf8') > maximum) fail(code);
  return value;
}
function traderId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) fail('VPAY_INVALID_TRADER_ID');
  return value;
}
function orderId(value, maximum = 50) {
  if (typeof value !== 'string' || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) fail('VPAY_INVALID_ORDER_ID');
  return value;
}

// Provider amounts are decimal strings. Never round floats or accept exponents.
// The outgoing canonical string also fits the documented 10-character limit.
export function normalizeVPayMYR(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,6})(?:\.(\d{1,2}))?$/.test(value)) fail('VPAY_INVALID_AMOUNT');
  const [whole, fraction = ''] = value.split('.');
  const decimal = fraction.padEnd(2, '0');
  const minor = BigInt(whole) * 100n + BigInt(decimal);
  if (minor <= 0n) fail('VPAY_INVALID_AMOUNT');
  return Object.freeze({ currency: 'MYR', amount: `${whole}.${decimal}`, amountMinor: minor.toString() });
}

function httpsURL(value, code) {
  text(value, 500, code);
  let parsed;
  try { parsed = new URL(value); } catch { fail(code); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || value.includes('#') || parsed.port) fail(code);
  return parsed;
}
function applicationURL(value, origin, notify = false) {
  const code = 'VPAY_INVALID_APPLICATION_URL';
  const target = httpsURL(value, code), allowed = httpsURL(origin, code);
  if (allowed.pathname !== '/' || allowed.search || origin.includes('?') || target.origin !== allowed.origin || (notify && value.includes('?'))) fail(code);
  return target.href;
}
function paymentURL(value) {
  const target = httpsURL(value, 'VPAY_INVALID_PAYMENT_URL');
  if (target.origin !== cashierOrigin || (target.pathname === '/' && !target.search)) fail('VPAY_INVALID_PAYMENT_URL');
  return target.href;
}
function context(value, withTradeNo = false) {
  record(value);
  if (value.currency !== 'MYR') fail('VPAY_CURRENCY_MISMATCH');
  const result = {
    traderId: traderId(value.traderId),
    outTradeNo: orderId(value.outTradeNo),
    ...normalizeVPayMYR(value.amount),
  };
  if (withTradeNo) result.tradeNo = orderId(value.tradeNo, 128);
  return result;
}

/** Server-only draft. Missing sign deliberately makes this unsendable as-is.
 * traderId, enabledTradeCodes and origins come from confirmed server configuration,
 * never from member input. Known method codes do not prove merchant activation.
 */
export function createUnsignedVPayOrder(input, configuration) {
  record(input); record(configuration);
  const expected = context(input);
  if (expected.traderId !== traderId(configuration.traderId)) fail('VPAY_MERCHANT_MISMATCH');
  if (!Array.isArray(configuration.enabledTradeCodes) || !configuration.enabledTradeCodes.length || configuration.enabledTradeCodes.some(code => !tradeCodes.has(code))) fail('VPAY_CHANNELS_UNCONFIRMED');
  if (!tradeCodes.has(input.tradeCode) || !configuration.enabledTradeCodes.includes(input.tradeCode)) fail('VPAY_CHANNEL_UNAVAILABLE');
  return Object.freeze({
    action: 'TRADER_ORDER', trader_id: expected.traderId,
    title: text(input.title, 100, 'VPAY_INVALID_TITLE'),
    out_trade_no: expected.outTradeNo, amount: expected.amount,
    trade_code: input.tradeCode,
    payer_name: text(input.payerName, 30, 'VPAY_INVALID_PAYER_NAME'),
    notify_url: applicationURL(input.notifyUrl, configuration.notifyOrigin, true),
    callback_url: applicationURL(input.callbackUrl, configuration.callbackOrigin),
  });
}

function envelope(value) {
  record(value);
  if (!Number.isInteger(value.code)) fail('VPAY_INVALID_RESPONSE_CODE');
  // Never surface the provider's raw msg, sign, token or account fields.
  if (value.code !== 0) fail('VPAY_PROVIDER_REJECTED');
  return record(value.data);
}
function match(data, expected, { merchantRequired = false, tradeNoRequired = false } = {}) {
  if (Object.hasOwn(data, 'currency') && data.currency !== expected.currency) fail('VPAY_CURRENCY_MISMATCH');
  if (merchantRequired || Object.hasOwn(data, 'trader_id')) {
    if (traderId(data.trader_id) !== expected.traderId) fail('VPAY_MERCHANT_MISMATCH');
  }
  if (orderId(data.out_trade_no) !== expected.outTradeNo) fail('VPAY_ORDER_MISMATCH');
  const tradeNo = orderId(data.trade_no, 128);
  if (tradeNoRequired && tradeNo !== expected.tradeNo) fail('VPAY_ORDER_MISMATCH');
  const amount = normalizeVPayMYR(data.amount);
  if (amount.amountMinor !== expected.amountMinor) fail('VPAY_AMOUNT_MISMATCH');
  return { traderId: expected.traderId, outTradeNo: expected.outTradeNo, tradeNo, ...amount };
}
function inspectResult(fields) {
  return Object.freeze({
    ...fields, provider: 'vpay', authenticated: false,
    environmentVerified: false, fundsProcessed: false,
    settlementStatus: 'verification_required',
  });
}
function state(value, notification) {
  // The table says integer; the examples use a digit string. Accept both.
  if (Number.isInteger(value) && value >= 0 && value <= 999) value = String(value);
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})$/.test(value)) fail('VPAY_INVALID_STATE');
  const states = ['not_generated', 'failed', 'pending', 'paid', 'reversed'];
  if (notification) states.push('risk_control');
  return { providerStateCode: value, providerState: states[Number(value)] || 'unknown' };
}

/** Field matching only: code=0 is order creation, never payment success. */
export function inspectVPayCreateResult(value, expectedOrder) {
  const data = envelope(value), expected = context(expectedOrder);
  return inspectResult({
    ...match(data, expected, { merchantRequired: true }),
    providerState: 'order_created',
    payUrl: paymentURL(data.pay_url),
    // Keep the opaque supplier time; its timezone is not yet confirmed.
    expiresAtRaw: text(data.expired_time, 64, 'VPAY_INVALID_EXPIRY'),
  });
}

/** Merchant ID is not required by the ORDER_GET response table. The caller
 * still needs authenticated transport and a confirmed merchant configuration.
 * A supplied ID is checked; its absence cannot prove a merchant identity.
 */
export function inspectVPayQueryResult(value, expectedOrder) {
  const data = envelope(value), expected = context(expectedOrder, true);
  return inspectResult({
    ...match(data, expected, { tradeNoRequired: true }),
    ...state(data.state, false), merchantReturned: Object.hasOwn(data, 'trader_id'),
  });
}

/** Untrusted callback inspection only. Not a signature verifier, webhook
 * handler, durable inbox or settlement operation. No SUCCESS acknowledgement.
 * Preserve the original raw payload separately for the future verifier;
 * these projected fields cannot reproduce signatures over extension fields.
 */
export function inspectVPayNotification(value, expectedOrder) {
  const data = record(value), expected = context(expectedOrder, true);
  text(data.sign, 16384, 'VPAY_MISSING_SIGNATURE');
  return inspectResult({
    ...match(data, expected, { merchantRequired: true, tradeNoRequired: true }),
    ...state(data.state, true), signaturePresent: true,
  });
}
