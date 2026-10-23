import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VPayContractError, normalizeVPayMYR, createUnsignedVPayOrder,
  inspectVPayCreateResult, inspectVPayQueryResult, inspectVPayNotification,
} from './vpay-contract.mjs';

// Entirely synthetic, with no API keys, supplier calls or database imports.
const expected = { traderId: '123456', outTradeNo: 'order_1', tradeNo: 'external_1', amount: '100.00', currency: 'MYR' };
const config = { traderId: expected.traderId, enabledTradeCodes: ['2'], notifyOrigin: 'https://api.example.test', callbackOrigin: 'https://www.example.test' };
const input = {
  ...expected, title: 'Deposit', tradeCode: '2', payerName: 'TEST USER',
  notifyUrl: 'https://api.example.test/payments/vpay/notify',
  callbackUrl: 'https://www.example.test/deposit/return',
};
const data = overrides => ({
  trader_id: expected.traderId, out_trade_no: expected.outTradeNo,
  trade_no: expected.tradeNo, amount: '100', state: '3',
  pay_url: 'https://payment.vpay.club/pay/test-order',
  expired_time: '2026-01-01 23:59:59', sign: 'synthetic-unverified-signature',
  ...overrides,
});
const response = overrides => ({ code: 0, msg: 'ok', data: data(overrides) });
const errorCode = (action, code) => assert.throws(action, error => error instanceof VPayContractError && error.code === code && error.message === code);
function unverified(result) {
  assert.equal(result.authenticated, false);
  assert.equal(result.environmentVerified, false);
  assert.equal(result.fundsProcessed, false);
  assert.equal(result.settlementStatus, 'verification_required');
}

test('MYR uses exact integer cents and a canonical decimal string', () => {
  for (const [value, amount, cents] of [['0.01', '0.01', '1'], ['0.1', '0.10', '10'], ['1', '1.00', '100'], ['100.0', '100.00', '10000'], ['9999999.99', '9999999.99', '999999999']]) {
    assert.deepEqual(normalizeVPayMYR(value), { currency: 'MYR', amount, amountMinor: cents });
  }
});

test('ambiguous, floating, excessive precision and nonpositive amounts are rejected', () => {
  for (const amount of [0.1, 100, null, undefined, '', '0', '0.00', '-1', '+1', ' 1', '1 ', '01', '1e2', '1,000', '.01', '1.', '1.001', '10000000', 'NaN', 'Infinity']) errorCode(() => normalizeVPayMYR(amount), 'VPAY_INVALID_AMOUNT');
});

test('unsigned order drafts whitelist fields and require an explicitly activated method', () => {
  const order = createUnsignedVPayOrder({ ...input, amount: '100', sign: 'private-placeholder', apiKey: 'private-placeholder', balance: '999' }, config);
  assert.deepEqual(order, {
    action: 'TRADER_ORDER', trader_id: '123456', title: 'Deposit',
    out_trade_no: 'order_1', amount: '100.00', trade_code: '2', payer_name: 'TEST USER',
    notify_url: input.notifyUrl, callback_url: input.callbackUrl,
  });
  assert(!JSON.stringify(order).includes('private-placeholder'));
  errorCode(() => createUnsignedVPayOrder({ ...input, traderId: '999999' }, config), 'VPAY_MERCHANT_MISMATCH');
  errorCode(() => createUnsignedVPayOrder(input, { ...config, traderId: undefined }), 'VPAY_INVALID_TRADER_ID');
  errorCode(() => createUnsignedVPayOrder(input, { ...config, enabledTradeCodes: [] }), 'VPAY_CHANNELS_UNCONFIRMED');
  errorCode(() => createUnsignedVPayOrder(input, { ...config, enabledTradeCodes: ['unknown'] }), 'VPAY_CHANNELS_UNCONFIRMED');
  for (const tradeCode of ['1', '3', '4', '5', '7', 'unknown', 2]) errorCode(() => createUnsignedVPayOrder({ ...input, tradeCode }, config), 'VPAY_CHANNEL_UNAVAILABLE');
});

test('order drafts validate merchant, generated order identifiers and text limits', () => {
  for (const traderId of ['', '0', 123456, '12345678901', 'x', '123\n']) errorCode(() => createUnsignedVPayOrder({ ...input, traderId }, config), 'VPAY_INVALID_TRADER_ID');
  for (const outTradeNo of ['', 123, 'x'.repeat(51), 'a&b', 'a b']) errorCode(() => createUnsignedVPayOrder({ ...input, outTradeNo }, config), 'VPAY_INVALID_ORDER_ID');
  for (const payerName of ['', 'x'.repeat(31), '名字'.repeat(6), 'test\nuser']) errorCode(() => createUnsignedVPayOrder({ ...input, payerName }, config), 'VPAY_INVALID_PAYER_NAME');
  errorCode(() => createUnsignedVPayOrder({ ...input, title: 'x'.repeat(101) }, config), 'VPAY_INVALID_TITLE');
  errorCode(() => createUnsignedVPayOrder({ ...input, currency: 'USDT' }, config), 'VPAY_CURRENCY_MISMATCH');
});

test('callback destinations are HTTPS and pinned to the independently configured application origins', () => {
  for (const notifyUrl of ['http://api.example.test/notify', 'https://api.example.test/notify?t=1', 'https://api.example.test/notify?', 'https://evil.example/notify', 'https://api.example.test.evil.example/notify', 'https://user:pass@api.example.test/notify', 'https://api.example.test:8443/notify', 'https://api.example.test/notify#fragment', 'https://api.example.test/notify#', 'not-a-url']) errorCode(() => createUnsignedVPayOrder({ ...input, notifyUrl }, config), 'VPAY_INVALID_APPLICATION_URL');
  errorCode(() => createUnsignedVPayOrder({ ...input, callbackUrl: 'https://evil.example/return' }, config), 'VPAY_INVALID_APPLICATION_URL');
  for (const notifyOrigin of ['http://api.example.test', 'https://api.example.test/unexpected', 'https://api.example.test/?x=1', 'https://api.example.test/?']) errorCode(() => createUnsignedVPayOrder(input, { ...config, notifyOrigin }), 'VPAY_INVALID_APPLICATION_URL');
});

test('API success indicates order creation only and the cashier URL is strictly constrained', () => {
  const result = inspectVPayCreateResult(response(), expected);
  unverified(result);
  assert.equal(result.providerState, 'order_created');
  assert.equal(result.amountMinor, '10000');
  assert.equal(result.expiresAtRaw, '2026-01-01 23:59:59');
  for (const pay_url of ['https://payment.vpay.club', 'https://payment.vpay.club/', 'https://payment.vpay.club/?', 'http://payment.vpay.club/pay', 'https://payment.vpay.club.evil.example/pay', 'https://payment.vpay.club@evil.example/pay', 'https://user:pass@payment.vpay.club/pay', 'https://payment.vpay.club:8443/pay', 'https://payment.vpay.club/pay#fragment', 'javascript:alert(1)', '/pay']) errorCode(() => inspectVPayCreateResult(response({ pay_url }), expected), 'VPAY_INVALID_PAYMENT_URL');
});

test('responses match merchant, internal order, provider order and exact amount', () => {
  for (const inspect of [inspectVPayCreateResult, inspectVPayQueryResult]) {
    errorCode(() => inspect(response({ trader_id: '999999' }), expected), 'VPAY_MERCHANT_MISMATCH');
    errorCode(() => inspect(response({ out_trade_no: 'different_order' }), expected), 'VPAY_ORDER_MISMATCH');
    errorCode(() => inspect(response({ amount: '100.01' }), expected), 'VPAY_AMOUNT_MISMATCH');
  }
  errorCode(() => inspectVPayQueryResult(response({ trade_no: 'different_external_order' }), expected), 'VPAY_ORDER_MISMATCH');
  errorCode(() => inspectVPayQueryResult(response(), { ...expected, tradeNo: undefined }), 'VPAY_INVALID_ORDER_ID');
});

test('ORDER_GET accepts the documented absence of trader ID without claiming identity verification', () => {
  const value = response(); delete value.data.trader_id;
  const result = inspectVPayQueryResult(value, expected);
  unverified(result);
  assert.equal(result.merchantReturned, false);
  errorCode(() => inspectVPayCreateResult(value, expected), 'VPAY_INVALID_TRADER_ID');
});

test('known integer and string query states remain unverified; undocumented states remain unknown', () => {
  for (const state of [0, 1, 2, 3, 4, '0', '1', '2', '3', '4']) {
    const result = inspectVPayQueryResult(response({ state }), expected);
    unverified(result);
    assert.equal(result.providerStateCode, String(state));
    assert.notEqual(result.providerState, 'unknown');
  }
  for (const state of [5, 99, '999']) {
    const result = inspectVPayQueryResult(response({ state }), expected);
    unverified(result);
    assert.equal(result.providerState, 'unknown');
  }
  for (const state of [-1, 3.1, true, null, '03', '3 ', '1000']) errorCode(() => inspectVPayQueryResult(response({ state }), expected), 'VPAY_INVALID_STATE');
});

test('a paid or reversed notification never authenticates, credits, or acknowledges the callback', () => {
  for (const state of [0, 1, 2, 3, 4, 5, '3', '5', 99]) {
    const result = inspectVPayNotification(data({ state }), expected);
    unverified(result);
    assert.equal(result.signaturePresent, true);
    assert.equal(result.acknowledgement, undefined);
    assert(!JSON.stringify(result).includes('SUCCESS'));
  }
  assert.equal(inspectVPayNotification(data({ state: 5 }), expected).providerState, 'risk_control');
  errorCode(() => inspectVPayNotification(data({ sign: '' }), expected), 'VPAY_MISSING_SIGNATURE');
  errorCode(() => inspectVPayNotification(data({ trader_id: '999999' }), expected), 'VPAY_MERCHANT_MISMATCH');
  errorCode(() => inspectVPayNotification(data({ out_trade_no: 'different' }), expected), 'VPAY_ORDER_MISMATCH');
  errorCode(() => inspectVPayNotification(data({ trade_no: 'different' }), expected), 'VPAY_ORDER_MISMATCH');
  errorCode(() => inspectVPayNotification(data({ amount: '100.01' }), expected), 'VPAY_AMOUNT_MISMATCH');
});

test('provider failure text, extra fields, signatures and recipient bank details are never projected', () => {
  const marker = 'private-placeholder-do-not-expose';
  const extra = { sign: marker, token: marker, acc_name: marker, acc_no: marker, bank_name: marker, extension: marker };
  const value = response(extra); value.msg = marker;
  for (const result of [inspectVPayCreateResult(value, expected), inspectVPayQueryResult(value, expected), inspectVPayNotification(data(extra), expected)]) assert(!JSON.stringify(result).includes(marker));
  errorCode(() => inspectVPayCreateResult({ code: 9, msg: marker, sign: marker }, expected), 'VPAY_PROVIDER_REJECTED');
  errorCode(() => inspectVPayCreateResult({ code: '0', data: data() }, expected), 'VPAY_INVALID_RESPONSE_CODE');
  for (const malformed of [null, [], 'not-json', new Date()]) errorCode(() => inspectVPayQueryResult(malformed, expected), 'VPAY_INVALID_OBJECT');
});

test('inspection leaves raw signed payloads unchanged for a future extension-aware verifier', () => {
  const value = data({ future_field: 'included-in-the-future-signature' });
  const before = structuredClone(value);
  inspectVPayNotification(value, expected);
  assert.deepEqual(value, before);
});
