import { createHash, timingSafeEqual } from 'node:crypto';

// GSPAY+ MYR contract preparation only. This module performs no network,
// database, wallet or payout operation. All channels remain disabled until
// the gateway transport, supplier QA and portal settlement path are verified.
export const GSPAY_API_ORIGIN = 'https://api.thegspay.com';
export const GSPAY_MYR_ENDPOINT_TEMPLATES = Object.freeze({
  payment: '/v2/integrations/operators/{operator_authentication_key}/payment',
  duitNow: '/v2/integrations/operators/{operator_authentication_key}/duitnow/payment',
  status: '/v2/integrations/operators/{operator_authentication_key}/getpayment',
  // The supplier dashboard documents the balance path with singular
  // "operator", unlike the payment paths above. It is recorded verbatim and
  // deliberately unused until its response schema is confirmed.
  balance: '/v2/integrations/operator/{operator_authentication_key}/get/balance',
});
export const GSPAY_DOCUMENTED_ORDER_TTL_SECONDS = 120;
export const GSPAY_DOCUMENTED_SERVER_IPS = Object.freeze(['52.221.96.227']);

const controls = /[\u0000-\u001f\u007f-\u009f]/u;

export class GSPayContractError extends Error {
  constructor(code) { super(code); this.name = 'GSPayContractError'; this.code = code; }
}

const fail = code => { throw new GSPayContractError(code); };

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('GSPAY_INVALID_OBJECT');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('GSPAY_INVALID_OBJECT');
  return value;
}

function boundedText(value, minimum, maximum, pattern, code) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum ||
      value !== value.trim() || controls.test(value) || !pattern.test(value)) fail(code);
  return value;
}

function transactionId(value) {
  return boundedText(value, 8, 100, /^[A-Za-z0-9_-]+$/, 'GSPAY_INVALID_TRANSACTION_ID');
}

function playerUsername(value) {
  // Matches the platform account format so delimiter-free provider signatures
  // cannot be influenced by whitespace or control characters.
  return boundedText(value, 3, 40, /^[a-z0-9_-]+$/, 'GSPAY_INVALID_PLAYER_USERNAME');
}

function privateValue(value, code) {
  return boundedText(value, 16, 256, /^[\x21-\x7e]+$/, code);
}

function signature(value) {
  return boundedText(value, 32, 32, /^[a-fA-F0-9]{32}$/, 'GSPAY_INVALID_SIGNATURE').toLowerCase();
}

function paymentId(value, code = 'GSPAY_INVALID_PAYMENT_ID') {
  if (Number.isSafeInteger(value) && value > 0) value = String(value);
  if (typeof value !== 'string' || !/^[1-9]\d{0,39}$/.test(value)) fail(code);
  return value;
}

function providerBoolean(value, code) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  fail(code);
}

function providerStatus(value) {
  if (!Number.isInteger(value) || ![0, 1, 2, 4].includes(value)) fail('GSPAY_INVALID_DUITNOW_STATUS');
  return value;
}

function md5(value) {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(left, 'utf8'), b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifySignature(provided, expected) {
  if (!constantTimeEqual(signature(provided), expected)) fail('GSPAY_SIGNATURE_MISMATCH');
}

function verifyAuthenticationKey(provided, expected) {
  const actual = privateValue(provided, 'GSPAY_INVALID_AUTH_KEY');
  const configured = privateValue(expected, 'GSPAY_INVALID_AUTH_KEY');
  if (!constantTimeEqual(actual, configured)) fail('GSPAY_AUTH_KEY_MISMATCH');
}

function expectedOrder(value, amountField = 'amount') {
  record(value);
  if (value.currency !== 'MYR') fail('GSPAY_CURRENCY_MISMATCH');
  return {
    transactionId: transactionId(value.transactionId),
    playerUsername: value.playerUsername === undefined ? null : playerUsername(value.playerUsername),
    ...normalizeGSPayMYR(value[amountField]),
  };
}

function matchPayment(value, expected, { playerRequired = true } = {}) {
  const responseTransaction = transactionId(value.transaction_id);
  const amount = normalizeGSPayMYR(value.amount);
  if (responseTransaction !== expected.transactionId) fail('GSPAY_TRANSACTION_MISMATCH');
  if (amount.amountMinor !== expected.amountMinor) fail('GSPAY_AMOUNT_MISMATCH');
  let responsePlayer = null;
  if (playerRequired) {
    responsePlayer = playerUsername(value.player_username);
    if (!expected.playerUsername || responsePlayer !== expected.playerUsername) fail('GSPAY_PLAYER_MISMATCH');
  }
  return { transactionId: responseTransaction, playerUsername: responsePlayer, ...amount };
}

function inspected(fields) {
  return Object.freeze({
    ...fields,
    provider: 'gspay_myr',
    signatureVerified: true,
    fundsProcessed: false,
  });
}

// Provider amounts are signed after canonical formatting with exactly two
// decimal places. Only exact decimal strings are accepted; floats and exponents
// are rejected instead of rounded.
export function normalizeGSPayMYR(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,11})(?:\.(\d{1,2}))?$/.test(value)) fail('GSPAY_INVALID_AMOUNT');
  const [whole, fraction = ''] = value.split('.');
  const decimal = fraction.padEnd(2, '0');
  const minor = BigInt(whole) * 100n + BigInt(decimal);
  if (minor <= 0n) fail('GSPAY_INVALID_AMOUNT');
  return Object.freeze({ currency: 'MYR', amount: `${whole}.${decimal}`, amountMinor: minor.toString() });
}

/**
 * Produces only the documented signed JSON body. Transport is deliberately
 * absent because the successful response schema and key placement still need
 * supplier confirmation. The same body formula is documented for Payment and
 * DuitNow order creation.
 */
export function createSignedGSPayMYROrder(input, operatorSecretKey) {
  const expected = expectedOrder(input);
  if (!expected.playerUsername) fail('GSPAY_INVALID_PLAYER_USERNAME');
  const secret = privateValue(operatorSecretKey, 'GSPAY_INVALID_SECRET_KEY');
  return Object.freeze({
    transaction_id: expected.transactionId,
    amount: expected.amount,
    player_username: expected.playerUsername,
    signature: md5(expected.transactionId + expected.playerUsername + expected.amount + secret),
  });
}

/**
 * Verifies a direct getpayment response against the locally stored order.
 * completed/success are not part of the documented MD5 formula, so a paid
 * result is eligible only inside a fixed-host authenticated TLS query flow.
 */
export function verifyGSPayMYRQueryResult(value, expectedValue, operatorSecretKey) {
  record(value);
  const expected = expectedOrder(expectedValue);
  if (!expected.playerUsername) fail('GSPAY_INVALID_PLAYER_USERNAME');
  const secret = privateValue(operatorSecretKey, 'GSPAY_INVALID_SECRET_KEY');
  const id = paymentId(value.payment_id);
  if (expectedValue.paymentId !== undefined && id !== paymentId(expectedValue.paymentId)) {
    fail('GSPAY_PAYMENT_ID_MISMATCH');
  }
  const matched = matchPayment(value, expected);
  verifySignature(value.signature, md5(id + matched.amount + matched.transactionId + secret));
  const completed = providerBoolean(value.completed, 'GSPAY_INVALID_COMPLETED');
  const success = providerBoolean(value.success, 'GSPAY_INVALID_SUCCESS');
  if (!completed && success) fail('GSPAY_INCONSISTENT_STATUS');
  const providerState = !completed ? 'pending' : success ? 'paid' : 'failed';
  return inspected({
    source: 'query', paymentId: id, ...matched, completed, success, providerState,
    settlementStatus: providerState === 'paid' ? 'query_confirmed' : 'not_payable',
  });
}

/**
 * Verifies the documented callback fields and the auth key supplied by the
 * future HTTP adapter. Callback status booleans are not covered by the MD5, so
 * even a reported success must be independently queried before settlement.
 */
export function verifyGSPayMYRCallback(envelope, expectedValue, configuration) {
  record(envelope); record(configuration);
  const { authKey, payload } = envelope;
  record(payload);
  verifyAuthenticationKey(authKey, configuration.operatorAuthenticationKey);
  const expected = expectedOrder(expectedValue);
  if (!expected.playerUsername) fail('GSPAY_INVALID_PLAYER_USERNAME');
  const secret = privateValue(configuration.operatorSecretKey, 'GSPAY_INVALID_SECRET_KEY');
  const id = paymentId(payload.payment_id);
  if (expectedValue.paymentId !== undefined && id !== paymentId(expectedValue.paymentId)) {
    fail('GSPAY_PAYMENT_ID_MISMATCH');
  }
  const matched = matchPayment(payload, expected);
  verifySignature(payload.signature, md5(id + matched.amount + matched.transactionId + secret));
  const completed = providerBoolean(payload.completed, 'GSPAY_INVALID_COMPLETED');
  const success = providerBoolean(payload.success, 'GSPAY_INVALID_SUCCESS');
  if (!completed && success) fail('GSPAY_INCONSISTENT_STATUS');
  const reportedState = !completed ? 'pending' : success ? 'paid' : 'failed';
  return inspected({
    source: 'callback', paymentId: id, ...matched, completed, success,
    reportedState, settlementStatus: 'independent_query_required',
  });
}

/**
 * DuitNow may return an altered unique payable amount. expectedValue therefore
 * requires payableAmount captured from the signed create response, never the
 * member's original requested amount. Status 1 is a manual-update success and
 * always requires finance review; status 2 still requires an independent query.
 */
export function verifyGSPayDuitNowCallback(envelope, expectedValue, configuration) {
  record(envelope); record(configuration);
  const { authKey, payload } = envelope;
  record(payload);
  verifyAuthenticationKey(authKey, configuration.operatorAuthenticationKey);
  const expected = expectedOrder(expectedValue, 'payableAmount');
  const secret = privateValue(configuration.operatorSecretKey, 'GSPAY_INVALID_SECRET_KEY');
  const id = paymentId(payload.dnpayment_id, 'GSPAY_INVALID_DUITNOW_PAYMENT_ID');
  const matched = matchPayment(payload, expected, { playerRequired: false });
  const status = providerStatus(payload.status);
  verifySignature(payload.signature, md5(id + matched.amount + matched.transactionId + status + secret));
  const states = {
    0: 'pending_or_expired',
    1: 'manual_success_review',
    2: 'paid',
    4: 'timeout_or_rejected',
  };
  // expire_date is documented in the body but omitted from the MD5 formula.
  // Retain it for reconciliation only; callers must not use it as a trusted
  // settlement or expiry decision.
  const reportedExpiresAtRaw = boundedText(payload.expire_date, 1, 80, /^[^\u0000-\u001f\u007f-\u009f]+$/, 'GSPAY_INVALID_EXPIRY');
  return inspected({
    source: 'duitnow_callback', duitNowPaymentId: id,
    transactionId: matched.transactionId, amount: matched.amount,
    amountMinor: matched.amountMinor, currency: matched.currency,
    status, providerState: states[status], reportedExpiresAtRaw,
    expirySignatureCovered: false,
    settlementStatus: status === 1 ? 'finance_review_required' : status === 2 ? 'independent_query_required' : 'not_payable',
  });
}
