import { createHash, randomUUID } from 'node:crypto';
import { normalizeGSPayMYR } from './gspay-contract.mjs';

const requestKeyPattern = /^[A-Za-z0-9_-]{16,100}$/;
const playerPattern = /^[a-z0-9_-]{3,40}$/;
const identifierPattern = /^[A-Za-z0-9_-]{8,100}$/;
const paymentIdPattern = /^[1-9]\d{0,39}$/;
const printable = /^[^\u0000-\u001f\u007f-\u009f]+$/u;
const maximumMinor = 10_000_000n;

export const GSPAY_CREATE_PROJECTION_CONTRACT = 'gspay-myr-create-v1';
export const GSPAY_CALLBACK_PROJECTION_CONTRACT = 'gspay-myr-callback-v1';
export const GSPAY_QUERY_PROJECTION_CONTRACT = 'gspay-myr-query-v1';

export class GSPayCheckoutError extends Error {
  constructor(code) { super(code); this.name = 'GSPayCheckoutError'; this.code = code; }
}

const fail = code => { throw new GSPayCheckoutError(code); };
const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const safeText = (value, min, max, pattern) => typeof value === 'string' && value.length >= min &&
  value.length <= max && value === value.trim() && pattern.test(value);
const amountFromMinor = value => {
  const minor = BigInt(value);
  return `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`;
};
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const capability = (object, names) => Boolean(object) && names.every(name => typeof object[name] === 'function');
const exactKeys = (value, keys, code = 'GSPAY_GATEWAY_RESULT_INVALID') => {
  const actual = Object.keys(value).sort(), expectedKeys = [...keys].sort();
  if (actual.length !== expectedKeys.length || actual.some((key, index) => key !== expectedKeys[index])) fail(code);
};

function validOrigins(values) {
  if (!Array.isArray(values) || !values.length || values.length > 8) return null;
  const origins = new Set();
  try {
    for (const value of values) {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
      origins.add(url.origin);
    }
  } catch { return null; }
  return origins.size === values.length ? origins : null;
}

function expected(order) {
  return {
    transactionId: order.transactionId,
    playerUsername: order.playerUsername,
    amount: amountFromMinor(order.amountMinor),
    amountMinor: String(order.amountMinor),
    currency: order.currency,
    ...(order.paymentId ? { paymentId: order.paymentId } : {}),
  };
}

function validateOrder(order, intent) {
  let orderMinor;
  try { orderMinor = BigInt(order?.amountMinor); } catch { fail('GSPAY_IDEMPOTENCY_CONFLICT'); }
  if (!isRecord(order) || !safeText(order.id, 8, 100, identifierPattern) ||
      !safeText(order.transactionId, 8, 100, identifierPattern) || order.transactionId !== order.id ||
      order.tenantId !== intent.tenantId || order.userId !== intent.userId || order.requestKey !== intent.requestKey ||
      order.playerUsername !== intent.playerUsername || order.currency !== 'MYR' ||
      orderMinor !== BigInt(intent.amountMinor) || order.fingerprint !== intent.fingerprint) {
    fail('GSPAY_IDEMPOTENCY_CONFLICT');
  }
  return order;
}

function assertGatewayProjection(value, source) {
  if (!isRecord(value) || value.provider !== 'gspay_myr' || value.source !== source ||
      value.gatewayAuthenticated !== true || value.signatureVerified !== true || value.fundsProcessed !== false) {
    fail('GSPAY_GATEWAY_RESULT_INVALID');
  }
  for (const forbidden of ['signature', 'remark', 'authKey', 'operatorAuthenticationKey', 'operatorSecretKey', 'raw', 'payload']) {
    if (Object.hasOwn(value, forbidden)) fail('GSPAY_GATEWAY_RESULT_INVALID');
  }
}

function validateCreateProjection(value, order, origins) {
  assertGatewayProjection(value, 'gateway_create');
  exactKeys(value, ['provider', 'contract', 'source', 'gatewayAuthenticated', 'signatureVerified', 'fundsProcessed',
    'createSchemaConfirmed', 'paymentId', 'transactionId', 'payUrl', 'expiresAtRaw',
    ...(Object.hasOwn(value, 'payableAmount') ? ['payableAmount'] : [])], 'GSPAY_CREATE_RESULT_INVALID');
  if (value.contract !== GSPAY_CREATE_PROJECTION_CONTRACT || value.createSchemaConfirmed !== true || value.transactionId !== order.transactionId ||
      typeof value.paymentId !== 'string' || !safeText(value.paymentId, 1, 40, paymentIdPattern)) fail('GSPAY_CREATE_RESULT_INVALID');
  let payUrl;
  try { payUrl = new URL(value.payUrl); } catch { fail('GSPAY_CREATE_RESULT_INVALID'); }
  if (typeof value.payUrl !== 'string' || value.payUrl.length > 2048 || payUrl.protocol !== 'https:' ||
      payUrl.username || payUrl.password || payUrl.hash || !origins.has(payUrl.origin)) fail('GSPAY_CREATE_RESULT_INVALID');
  if (!safeText(value.expiresAtRaw, 1, 80, printable)) fail('GSPAY_CREATE_RESULT_INVALID');
  let payableAmount = null;
  if (value.payableAmount !== undefined && value.payableAmount !== null) {
    payableAmount = normalizeGSPayMYR(value.payableAmount).amount;
  }
  return Object.freeze({
    paymentId: String(value.paymentId), payUrl: payUrl.toString(),
    expiresAtRaw: value.expiresAtRaw, payableAmount, transactionId: order.transactionId,
  });
}

function validateCallbackProjection(channel, value, order, context) {
  if (context?.gatewayAuthenticated !== true || !isRecord(value) ||
      value.provider !== 'gspay_myr' || value.source !== (channel === 'payment' ? 'gateway_callback' : 'gateway_duitnow_callback') ||
      value.signatureVerified !== true || value.fundsProcessed !== false || Object.hasOwn(value, 'gatewayAuthenticated')) {
    fail('GSPAY_GATEWAY_RESULT_INVALID');
  }
  if (value.contract !== GSPAY_CALLBACK_PROJECTION_CONTRACT) fail('GSPAY_GATEWAY_RESULT_INVALID');
  exactKeys(value, ['provider', 'contract', 'source', 'signatureVerified', 'fundsProcessed', 'providerId',
    'transactionId', 'amountMinor', 'currency', 'providerState', 'settlementStatus',
    ...(channel === 'payment' ? ['playerUsername'] : [])]);
  for (const forbidden of ['signature', 'remark', 'authKey', 'operatorAuthenticationKey', 'operatorSecretKey', 'raw', 'payload']) {
    if (Object.hasOwn(value, forbidden)) fail('GSPAY_GATEWAY_RESULT_INVALID');
  }
  let expectedMinor;
  try {
    expectedMinor = channel === 'duitnow' ? normalizeGSPayMYR(order.payableAmount).amountMinor : String(order.amountMinor);
  } catch { fail('GSPAY_CALLBACK_MISMATCH'); }
  if (value.transactionId !== order.transactionId || value.currency !== 'MYR' ||
      typeof value.providerId !== 'string' || !safeText(value.providerId, 1, 40, paymentIdPattern) ||
      typeof value.amountMinor !== 'string' || value.amountMinor !== String(expectedMinor)) fail('GSPAY_CALLBACK_MISMATCH');
  if (order.paymentId && String(value.providerId) !== order.paymentId) fail('GSPAY_CALLBACK_MISMATCH');
  if (channel === 'payment' && value.playerUsername !== order.playerUsername) fail('GSPAY_CALLBACK_MISMATCH');
  const allowedActions = channel === 'payment' ? new Set(['independent_query_required'])
    : new Set(['independent_query_required', 'finance_review_required', 'not_payable']);
  if (!allowedActions.has(value.settlementStatus) || !safeText(value.providerState, 3, 40, /^[a-z0-9_]+$/)) {
    fail('GSPAY_CALLBACK_MISMATCH');
  }
  return Object.freeze({
    channel, providerId: String(value.providerId), transactionId: order.transactionId,
    amountMinor: String(value.amountMinor), currency: 'MYR',
    reportedState: value.providerState, action: value.settlementStatus,
  });
}

function validateQueryProjection(value, order) {
  assertGatewayProjection(value, 'gateway_query');
  exactKeys(value, ['provider', 'contract', 'source', 'gatewayAuthenticated', 'signatureVerified', 'fundsProcessed',
    'paymentId', 'transactionId', 'playerUsername', 'currency', 'amount', 'amountMinor', 'completed', 'success',
    'providerState', 'settlementStatus']);
  if (value.contract !== GSPAY_QUERY_PROJECTION_CONTRACT || value.transactionId !== order.transactionId || value.playerUsername !== order.playerUsername ||
      value.currency !== 'MYR' || value.amount !== amountFromMinor(order.amountMinor) ||
      typeof value.amountMinor !== 'string' || value.amountMinor !== String(order.amountMinor) ||
      typeof value.paymentId !== 'string' || !safeText(value.paymentId, 1, 40, paymentIdPattern) ||
      (order.paymentId && String(value.paymentId) !== order.paymentId) ||
      !['pending', 'paid', 'failed'].includes(value.providerState)) fail('GSPAY_QUERY_MISMATCH');
  if (![true, false].includes(value.completed) || ![true, false].includes(value.success)) fail('GSPAY_QUERY_MISMATCH');
  const paid = value.completed && value.success;
  if ((!value.completed && value.success) || (value.providerState === 'paid') !== paid ||
      value.settlementStatus !== (paid ? 'query_confirmed' : 'not_payable')) fail('GSPAY_QUERY_MISMATCH');
  return Object.freeze({
    provider: 'gspay_myr', contract: GSPAY_QUERY_PROJECTION_CONTRACT, source: 'gateway_query',
    gatewayAuthenticated: true, signatureVerified: true, fundsProcessed: false,
    paymentId: value.paymentId, transactionId: value.transactionId, playerUsername: value.playerUsername,
    currency: 'MYR', amount: value.amount, amountMinor: value.amountMinor,
    completed: value.completed, success: value.success,
    providerState: value.providerState, settlementStatus: value.settlementStatus,
  });
}

function publicResult(order) {
  const state = order.settlementStatus === 'credited' ? 'credited'
    : order.reviewRequired ? 'review_required'
      : order.createState === 'created' && order.payUrl ? 'awaiting_payment'
        : 'awaiting_confirmation';
  return Object.freeze({
    id: order.id, status: state,
    payUrl: state === 'awaiting_payment' ? order.payUrl : null,
    expiresAtRaw: state === 'awaiting_payment' ? order.expiresAtRaw || null : null,
  });
}

/**
 * Portal-side GSPAY+ MYR orchestration. It receives only authenticated,
 * sanitized projections from the separate integration gateway. Supplier keys,
 * raw callbacks, MD5 signatures and provider transport never enter this module.
 */
export function createGSPayCheckoutCore({
  ordersEnabled = false,
  callbacksEnabled = false,
  settlementEnabled = false,
  allowedPaymentOrigins,
  inspectCreateResult,
  resolvePlayerUsername,
  store,
  gateway,
  settlement,
  now = () => new Date(),
  idFactory = randomUUID,
} = {}) {
  const origins = validOrigins(allowedPaymentOrigins);
  let gatewayStatus = null;
  try {
    const value = typeof gateway?.status === 'function' ? gateway.status() : null;
    if (isRecord(value)) gatewayStatus = value;
  } catch { gatewayStatus = null; }
  const gatewayContractReady = gatewayStatus?.provider === 'gspay_myr' &&
    gatewayStatus.configured === true && gatewayStatus.contractVersionConfirmed === true;
  const orderStoreReady = capability(store, ['reserve', 'claimCreate', 'markCreated', 'markCreateUnknown']);
  const callbackStoreReady = capability(store, ['findByTransactionId', 'recordCallback']);
  const queryStoreReady = capability(store, ['findById', 'claimQuery', 'finishQuery']);
  const ordersReady = ordersEnabled === true && Boolean(origins) && orderStoreReady && gatewayContractReady &&
    gatewayStatus.ordersReady === true && gatewayStatus.liveReady === true &&
    capability(gateway, ['createPayment']) && typeof inspectCreateResult === 'function' &&
    typeof resolvePlayerUsername === 'function';
  const callbacksReady = callbacksEnabled === true && callbackStoreReady && gatewayContractReady &&
    gatewayStatus.callbacksReady === true;
  const settlementReady = settlementEnabled === true && callbacksReady && queryStoreReady &&
    gatewayStatus.queryReady === true && gatewayStatus.liveReady === true &&
    capability(gateway, ['queryPayment']) && capability(settlement, ['commitConfirmed']);

  function status() {
    return Object.freeze({ provider: 'gspay_myr', currency: 'MYR', enabled: ordersReady,
      ordersEnabled: ordersReady, callbacksEnabled: callbacksReady, settlementEnabled: settlementReady,
      liveReady: ordersReady && callbacksReady && settlementReady });
  }

  async function submit(user, input) {
    if (!ordersReady) fail('GSPAY_CHECKOUT_DISABLED');
    if (!user || user.role !== 'customer' || !safeText(user.userId, 1, 100, /^[A-Za-z0-9_-]+$/) ||
        !safeText(user.tenantId || 'main', 1, 60, /^[A-Za-z0-9_-]+$/)) fail('GSPAY_MEMBER_UNAVAILABLE');
    if (!isRecord(input) || input.currency !== 'MYR' || !safeText(input.requestKey, 16, 100, requestKeyPattern)) fail('GSPAY_INVALID_ORDER');
    let normalized, playerUsername;
    try { normalized = normalizeGSPayMYR(input.amount); playerUsername = await resolvePlayerUsername(user); }
    catch { fail('GSPAY_INVALID_ORDER'); }
    if (BigInt(normalized.amountMinor) > maximumMinor || !safeText(playerUsername, 3, 40, playerPattern)) fail('GSPAY_INVALID_ORDER');
    const core = { tenantId: user.tenantId || 'main', userId: user.userId, requestKey: input.requestKey,
      playerUsername, currency: 'MYR', amountMinor: normalized.amountMinor };
    const intent = { ...core, fingerprint: fingerprint(core) };
    const reserved = await store.reserve({ ...intent, id: idFactory(), createdAt: now().toISOString() });
    let order = validateOrder(reserved?.order, intent);
    const claim = await store.claimCreate(order.id, { fingerprint: intent.fingerprint, attemptedAt: now().toISOString() });
    order = validateOrder(claim?.order, intent);
    if (!claim?.claimed) return publicResult(order);
    try {
      const draft = Object.freeze({ transactionId: order.transactionId, playerUsername: order.playerUsername,
        amount: amountFromMinor(order.amountMinor), currency: 'MYR' });
      const raw = await gateway.createPayment(draft);
      const projected = validateCreateProjection(await inspectCreateResult(raw, expected(order)), order, origins);
      order = validateOrder(await store.markCreated(order.id, { ...projected, createdAt: now().toISOString() }), intent);
      return publicResult(order);
    } catch {
      order = validateOrder(await store.markCreateUnknown(order.id, {
        reason: 'GSPAY_ORDER_CREATION_PENDING', updatedAt: now().toISOString(),
      }), intent);
      return publicResult(order);
    }
  }

  async function receiveCallback(channel, projection, context) {
    if (!callbacksReady) fail('GSPAY_CALLBACKS_DISABLED');
    if (!['payment', 'duitnow'].includes(channel) || !isRecord(projection) ||
        !safeText(projection.transactionId, 8, 100, identifierPattern)) fail('GSPAY_INVALID_CALLBACK');
    const order = await store.findByTransactionId(projection.transactionId);
    if (!order || order.provider !== 'gspay_myr') fail('GSPAY_ORDER_UNKNOWN');
    let safeProjection;
    try { safeProjection = validateCallbackProjection(channel, projection, order, context); }
    catch (error) { if (error instanceof GSPayCheckoutError) throw error; fail('GSPAY_CALLBACK_MISMATCH'); }
    const event = Object.freeze({ ...safeProjection, eventId: fingerprint(safeProjection), receivedAt: now().toISOString() });
    await store.recordCallback(order.id, event);
    return Object.freeze({ recorded: true, orderId: order.id, eventId: event.eventId,
      status: event.action === 'independent_query_required' ? 'pending_query'
        : event.action === 'finance_review_required' ? 'review_required' : 'recorded',
      fundsProcessed: false });
  }

  async function reconcile(orderId) {
    if (!settlementReady) fail('GSPAY_SETTLEMENT_DISABLED');
    if (!safeText(orderId, 8, 100, identifierPattern)) fail('GSPAY_ORDER_UNKNOWN');
    let order = await store.findById(orderId);
    if (!order || order.provider !== 'gspay_myr') fail('GSPAY_ORDER_UNKNOWN');
    if (order.settlementStatus === 'credited') return publicResult(order);
    const claim = await store.claimQuery(order.id, { attemptedAt: now().toISOString() });
    order = claim?.order || order;
    if (!claim?.claimed) return publicResult(order);
    let projection;
    try { projection = validateQueryProjection(await gateway.queryPayment(expected(order)), order); }
    catch {
      order = await store.finishQuery(order.id, { queryState: 'pending', reason: 'GSPAY_QUERY_PENDING', updatedAt: now().toISOString() });
      return publicResult(order);
    }
    if (projection.providerState !== 'paid') {
      order = await store.finishQuery(order.id, { queryState: projection.providerState,
        providerId: projection.paymentId, reason: projection.providerState === 'failed' ? 'GSPAY_PAYMENT_FAILED' : 'GSPAY_PAYMENT_PENDING',
        updatedAt: now().toISOString() });
      return publicResult(order);
    }
    try {
      // This is the only paid transition. The injected implementation must do
      // order CAS, wallet journal, inbox/attempt completion and audit in one DB transaction.
      const outcome = await settlement.commitConfirmed({ order, confirmation: projection, committedAt: now().toISOString() });
      if (!outcome || (outcome.credited !== true && outcome.alreadyCredited !== true) || !isRecord(outcome.order)) {
        fail('GSPAY_SETTLEMENT_RETRY');
      }
      return publicResult(outcome.order);
    } catch {
      order = await store.finishQuery(order.id, { queryState: 'pending', reason: 'GSPAY_SETTLEMENT_RETRY', updatedAt: now().toISOString() });
      return publicResult(order);
    }
  }

  return Object.freeze({ status, submit, receiveCallback, reconcile });
}
