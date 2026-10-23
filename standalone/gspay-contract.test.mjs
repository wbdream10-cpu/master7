import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GSPAY_API_ORIGIN,
  GSPAY_MYR_ENDPOINT_TEMPLATES,
  GSPAY_DOCUMENTED_ORDER_TTL_SECONDS,
  GSPAY_DOCUMENTED_SERVER_IPS,
  GSPayContractError,
  normalizeGSPayMYR,
  createSignedGSPayMYROrder,
  verifyGSPayMYRQueryResult,
  verifyGSPayMYRCallback,
  verifyGSPayDuitNowCallback,
} from './gspay-contract.mjs';

// Entirely synthetic. These tests never import production credentials, open a
// network connection, create an order, update a wallet or acknowledge a callback.
const secret = 'operator_secret_key';
const authKey = 'operator_authentication_key';
const expected = {
  transactionId: 'transaction_123',
  playerUsername: 'player_user',
  amount: '10.00',
  currency: 'MYR',
};
const configuration = { operatorAuthenticationKey: authKey, operatorSecretKey: secret };
const hash = value => createHash('md5').update(value, 'utf8').digest('hex');
const errorCode = (action, code) => assert.throws(
  action,
  error => error instanceof GSPayContractError && error.code === code && error.message === code,
);

function payment(overrides = {}) {
  const value = {
    payment_id: '10001',
    transaction_id: expected.transactionId,
    player_username: expected.playerUsername,
    amount: expected.amount,
    completed: true,
    success: true,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'signature')) {
    value.signature = hash(`${value.payment_id}${normalizeGSPayMYR(value.amount).amount}${value.transaction_id}${secret}`);
  }
  return value;
}

function duitNow(status, overrides = {}) {
  const value = {
    dnpayment_id: '20002',
    transaction_id: expected.transactionId,
    amount: '10.01',
    expire_date: '2026-10-24 12:34:56',
    status,
    ...overrides,
  };
  if (!Object.hasOwn(overrides, 'signature')) {
    value.signature = hash(`${value.dnpayment_id}${normalizeGSPayMYR(value.amount).amount}${value.transaction_id}${value.status}${secret}`);
  }
  return value;
}

test('documented fixed API metadata is recorded without making a request', () => {
  assert.equal(GSPAY_API_ORIGIN, 'https://api.thegspay.com');
  assert.deepEqual(GSPAY_MYR_ENDPOINT_TEMPLATES, {
    payment: '/v2/integrations/operators/{operator_authentication_key}/payment',
    duitNow: '/v2/integrations/operators/{operator_authentication_key}/duitnow/payment',
    status: '/v2/integrations/operators/{operator_authentication_key}/getpayment',
    balance: '/v2/integrations/operator/{operator_authentication_key}/get/balance',
  });
  assert.equal(GSPAY_DOCUMENTED_ORDER_TTL_SECONDS, 120);
  assert.deepEqual(GSPAY_DOCUMENTED_SERVER_IPS, ['52.221.96.227']);
});

test('MYR normalization uses exact integer cents and never rounds floats', () => {
  for (const [value, amount, minor] of [
    ['0.01', '0.01', '1'],
    ['0.1', '0.10', '10'],
    ['1', '1.00', '100'],
    ['10.0', '10.00', '1000'],
    ['999999999999.99', '999999999999.99', '99999999999999'],
  ]) {
    assert.deepEqual(normalizeGSPayMYR(value), { currency: 'MYR', amount, amountMinor: minor });
  }

  for (const value of [
    10, 0.1, null, undefined, '', '0', '0.00', '-1', '+1', ' 1', '1 ',
    '01', '1e2', '1,000', '.01', '1.', '1.001', '1000000000000', 'NaN', 'Infinity',
  ]) errorCode(() => normalizeGSPayMYR(value), 'GSPAY_INVALID_AMOUNT');
});

test('documented order signature vector matches exactly and exposes no secret', () => {
  const order = createSignedGSPayMYROrder({
    transactionId: 'transaction_id',
    playerUsername: 'player_username',
    amount: '10.00',
    currency: 'MYR',
    operatorSecretKey: 'must-not-be-projected',
    ignored: 'must-not-be-projected',
  }, secret);

  assert.deepEqual(order, {
    transaction_id: 'transaction_id',
    amount: '10.00',
    player_username: 'player_username',
    signature: '0539187f3e6c875e6e5ec0bb6897e70c',
  });
  assert(!JSON.stringify(order).includes(secret));
  assert(!JSON.stringify(order).includes('must-not-be-projected'));
});

test('order signing rejects malformed identifiers, players, currency and keys', () => {
  errorCode(() => createSignedGSPayMYROrder({ ...expected, transactionId: 'short' }, secret), 'GSPAY_INVALID_TRANSACTION_ID');
  errorCode(() => createSignedGSPayMYROrder({ ...expected, transactionId: 'transaction id' }, secret), 'GSPAY_INVALID_TRANSACTION_ID');
  errorCode(() => createSignedGSPayMYROrder({ ...expected, playerUsername: 'Player_User' }, secret), 'GSPAY_INVALID_PLAYER_USERNAME');
  errorCode(() => createSignedGSPayMYROrder({ ...expected, playerUsername: 'ab' }, secret), 'GSPAY_INVALID_PLAYER_USERNAME');
  errorCode(() => createSignedGSPayMYROrder({ ...expected, currency: 'USDT' }, secret), 'GSPAY_CURRENCY_MISMATCH');
  errorCode(() => createSignedGSPayMYROrder(expected, 'too-short'), 'GSPAY_INVALID_SECRET_KEY');
  errorCode(() => createSignedGSPayMYROrder(new Date(), secret), 'GSPAY_INVALID_OBJECT');
});

test('query status is projected only after matching the signed order', () => {
  const paid = verifyGSPayMYRQueryResult(payment(), expected, secret);
  assert.deepEqual(paid, {
    source: 'query',
    paymentId: '10001',
    transactionId: expected.transactionId,
    playerUsername: expected.playerUsername,
    currency: 'MYR',
    amount: '10.00',
    amountMinor: '1000',
    completed: true,
    success: true,
    providerState: 'paid',
    settlementStatus: 'query_confirmed',
    provider: 'gspay_myr',
    signatureVerified: true,
    fundsProcessed: false,
  });

  for (const [completed, success, providerState] of [
    [false, false, 'pending'],
    [0, 0, 'pending'],
    [true, false, 'failed'],
    [1, 0, 'failed'],
    [1, 1, 'paid'],
  ]) {
    const result = verifyGSPayMYRQueryResult(payment({ completed, success }), expected, secret);
    assert.equal(result.providerState, providerState);
    assert.equal(result.settlementStatus, providerState === 'paid' ? 'query_confirmed' : 'not_payable');
    assert.equal(result.fundsProcessed, false);
  }
  errorCode(() => verifyGSPayMYRQueryResult(payment({ completed: false, success: true }), expected, secret), 'GSPAY_INCONSISTENT_STATUS');
  for (const completed of ['1', null, 2]) errorCode(() => verifyGSPayMYRQueryResult(payment({ completed }), expected, secret), 'GSPAY_INVALID_COMPLETED');
  for (const success of ['0', null, 2]) errorCode(() => verifyGSPayMYRQueryResult(payment({ success }), expected, secret), 'GSPAY_INVALID_SUCCESS');
});

test('query verification rejects signature, order, member and amount mismatches', () => {
  errorCode(() => verifyGSPayMYRQueryResult(payment({ signature: '0'.repeat(32) }), expected, secret), 'GSPAY_SIGNATURE_MISMATCH');
  errorCode(() => verifyGSPayMYRQueryResult(payment({ transaction_id: 'transaction_999' }), expected, secret), 'GSPAY_TRANSACTION_MISMATCH');
  errorCode(() => verifyGSPayMYRQueryResult(payment({ player_username: 'another_user' }), expected, secret), 'GSPAY_PLAYER_MISMATCH');
  errorCode(() => verifyGSPayMYRQueryResult(payment({ amount: '10.01' }), expected, secret), 'GSPAY_AMOUNT_MISMATCH');
  errorCode(() => verifyGSPayMYRQueryResult(payment({ payment_id: '0' }), expected, secret), 'GSPAY_INVALID_PAYMENT_ID');
  errorCode(() => verifyGSPayMYRQueryResult(payment(), { ...expected, paymentId: '99999' }, secret), 'GSPAY_PAYMENT_ID_MISMATCH');
  errorCode(() => verifyGSPayMYRQueryResult(payment({ payment_id: '10001', signature: 'not-a-signature' }), expected, secret), 'GSPAY_INVALID_SIGNATURE');
});

test('payment identifiers accept lossless strings and reject unsafe JSON numbers', () => {
  const largeId = '90071992547409931234567890';
  const stringResult = verifyGSPayMYRQueryResult(payment({ payment_id: largeId }), expected, secret);
  assert.equal(stringResult.paymentId, largeId);

  errorCode(
    () => verifyGSPayMYRQueryResult(payment({ payment_id: 9007199254740993 }), expected, secret),
    'GSPAY_INVALID_PAYMENT_ID',
  );

  const safeResult = verifyGSPayMYRQueryResult(payment({ payment_id: 10001 }), expected, secret);
  assert.equal(safeResult.paymentId, '10001');
});

test('generic callback verifies auth and signature but always requires an independent query', () => {
  const marker = 'private-placeholder-do-not-project';
  const payload = payment({ operator_secret_key: marker, auth_key: marker, remark: marker });
  const result = verifyGSPayMYRCallback({ authKey, payload }, expected, configuration);
  assert.equal(result.reportedState, 'paid');
  assert.equal(result.settlementStatus, 'independent_query_required');
  assert.equal(result.signatureVerified, true);
  assert.equal(result.fundsProcessed, false);
  assert(!JSON.stringify(result).includes(marker));
  assert(!JSON.stringify(result).includes(authKey));
  assert(!JSON.stringify(result).includes(secret));

  errorCode(() => verifyGSPayMYRCallback({ authKey: 'different_authentication_key', payload: payment() }, expected, configuration), 'GSPAY_AUTH_KEY_MISMATCH');
  errorCode(() => verifyGSPayMYRCallback({ authKey, payload: payment({ signature: 'f'.repeat(32) }) }, expected, configuration), 'GSPAY_SIGNATURE_MISMATCH');
  errorCode(() => verifyGSPayMYRCallback({ authKey, payload: payment({ amount: '10.01' }) }, expected, configuration), 'GSPAY_AMOUNT_MISMATCH');
  errorCode(() => verifyGSPayMYRCallback({ authKey, payload: payment({ player_username: 'another_user' }) }, expected, configuration), 'GSPAY_PLAYER_MISMATCH');
  errorCode(() => verifyGSPayMYRCallback({ authKey, payload: payment() }, { ...expected, paymentId: '99999' }, configuration), 'GSPAY_PAYMENT_ID_MISMATCH');
});

test('DuitNow callback signs the supplier payable amount and maps every documented status', () => {
  const duitNowExpected = { ...expected, amount: '10.00', payableAmount: '10.01' };
  for (const [status, providerState, settlementStatus] of [
    [0, 'pending_or_expired', 'not_payable'],
    [1, 'manual_success_review', 'finance_review_required'],
    [2, 'paid', 'independent_query_required'],
    [4, 'timeout_or_rejected', 'not_payable'],
  ]) {
    const result = verifyGSPayDuitNowCallback({ authKey, payload: duitNow(status) }, duitNowExpected, configuration);
    assert.equal(result.providerState, providerState);
    assert.equal(result.settlementStatus, settlementStatus);
    assert.equal(result.amount, '10.01');
    assert.equal(result.amountMinor, '1001');
    assert.equal(result.reportedExpiresAtRaw, '2026-10-24 12:34:56');
    assert.equal(result.expirySignatureCovered, false);
    assert.equal(result.fundsProcessed, false);
  }
});

test('DuitNow callback rejects wrong payable amount, auth, signature, status and expiry', () => {
  const duitNowExpected = { ...expected, payableAmount: '10.01' };
  errorCode(() => verifyGSPayDuitNowCallback({ authKey, payload: duitNow(2) }, { ...duitNowExpected, payableAmount: '10.00' }, configuration), 'GSPAY_AMOUNT_MISMATCH');
  errorCode(() => verifyGSPayDuitNowCallback({ authKey: 'different_authentication_key', payload: duitNow(2) }, duitNowExpected, configuration), 'GSPAY_AUTH_KEY_MISMATCH');
  errorCode(() => verifyGSPayDuitNowCallback({ authKey, payload: duitNow(2, { signature: '0'.repeat(32) }) }, duitNowExpected, configuration), 'GSPAY_SIGNATURE_MISMATCH');
  errorCode(() => verifyGSPayDuitNowCallback({ authKey, payload: duitNow(3) }, duitNowExpected, configuration), 'GSPAY_INVALID_DUITNOW_STATUS');
  errorCode(() => verifyGSPayDuitNowCallback({ authKey, payload: duitNow(2, { expire_date: 'bad\nexpiry' }) }, duitNowExpected, configuration), 'GSPAY_INVALID_EXPIRY');
  errorCode(() => verifyGSPayDuitNowCallback({ authKey, payload: duitNow(2, { dnpayment_id: 9007199254740993 }) }, duitNowExpected, configuration), 'GSPAY_INVALID_DUITNOW_PAYMENT_ID');
});

test('malformed objects and noncanonical expected orders are rejected', () => {
  for (const malformed of [null, [], 'not-json', new Date()]) {
    errorCode(() => verifyGSPayMYRQueryResult(malformed, expected, secret), 'GSPAY_INVALID_OBJECT');
  }
  errorCode(() => verifyGSPayMYRQueryResult(payment(), { ...expected, currency: 'USD' }, secret), 'GSPAY_CURRENCY_MISMATCH');
  errorCode(() => verifyGSPayMYRCallback({ authKey, payload: payment() }, expected, []), 'GSPAY_INVALID_OBJECT');
  errorCode(() => verifyGSPayMYRCallback({ authKey, payload: [] }, expected, configuration), 'GSPAY_INVALID_OBJECT');
  errorCode(() => verifyGSPayMYRCallback(null, expected, configuration), 'GSPAY_INVALID_OBJECT');
  errorCode(() => verifyGSPayDuitNowCallback(null, expected, configuration), 'GSPAY_INVALID_OBJECT');
});
