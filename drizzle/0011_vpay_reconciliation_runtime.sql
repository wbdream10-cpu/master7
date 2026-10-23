-- Persist only the validated semantic projection of VPay callbacks. Raw JSON,
-- signatures, bearer tokens, API keys, and provider remarks are deliberately
-- excluded from this table.
CREATE TABLE portal_vpay_callbacks (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL,
 provider TEXT NOT NULL DEFAULT 'vpay' CHECK(provider='vpay'),
 event_key_hash TEXT NOT NULL UNIQUE
  CHECK(length(event_key_hash)=64 AND event_key_hash=lower(event_key_hash) AND event_key_hash NOT GLOB '*[^0-9a-f]*'),
 provider_trade_no TEXT NOT NULL CHECK(length(provider_trade_no)>=1 AND length(provider_trade_no)<=128),
 reported_status TEXT NOT NULL CHECK(reported_status IN ('pending','paid','failed','reversed','risk_control','unknown')),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0 AND amount_minor<=10000000),
 currency TEXT NOT NULL CHECK(currency='MYR'),
 processing_state TEXT NOT NULL DEFAULT 'pending_query'
  CHECK(processing_state IN ('pending_query','processed','rejected','review_required')),
 rejection_code TEXT CHECK(rejection_code IS NULL OR (length(rejection_code)>=3 AND length(rejection_code)<=64)),
 received_at TEXT NOT NULL,
 processed_at TEXT,
 FOREIGN KEY(order_id,provider) REFERENCES portal_payment_orders(id,provider),
 UNIQUE(id,order_id),
 CHECK(
  (processing_state='pending_query' AND processed_at IS NULL AND rejection_code IS NULL) OR
  (processing_state='processed' AND processed_at IS NOT NULL AND rejection_code IS NULL) OR
  (processing_state IN ('rejected','review_required') AND processed_at IS NOT NULL AND rejection_code IS NOT NULL)
 )
);

-- An attempt row is both an audit trail and a distributed query lease. A
-- worker may finish only the in-flight row whose unguessable claim_token it
-- owns; an expired row is fenced before a new worker can claim the order.
CREATE TABLE portal_vpay_attempts (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL,
 provider TEXT NOT NULL DEFAULT 'vpay' CHECK(provider='vpay'),
 callback_id TEXT,
 operation TEXT NOT NULL CHECK(operation IN ('create','query')),
 attempt_key TEXT NOT NULL CHECK(length(attempt_key)>=8 AND length(attempt_key)<=128),
 claim_token TEXT UNIQUE CHECK(claim_token IS NULL OR (length(claim_token)>=16 AND length(claim_token)<=128)),
 lease_expires_at TEXT,
 outcome TEXT NOT NULL CHECK(outcome IN ('in_flight','succeeded','failed','unknown')),
 result_code TEXT CHECK(result_code IS NULL OR (length(result_code)>=3 AND length(result_code)<=64)),
 observed_trade_no TEXT CHECK(observed_trade_no IS NULL OR (length(observed_trade_no)>=1 AND length(observed_trade_no)<=128)),
 observed_status TEXT CHECK(observed_status IS NULL OR observed_status IN ('pending','paid','failed','reversed','unknown')),
 observed_amount_minor INTEGER CHECK(observed_amount_minor IS NULL OR (observed_amount_minor>0 AND observed_amount_minor<=10000000)),
 started_at TEXT NOT NULL,
 completed_at TEXT,
 FOREIGN KEY(order_id,provider) REFERENCES portal_payment_orders(id,provider),
 FOREIGN KEY(callback_id,order_id) REFERENCES portal_vpay_callbacks(id,order_id),
 UNIQUE(order_id,operation,attempt_key),
 CHECK(callback_id IS NULL OR operation='query'),
 CHECK(
  (operation='query' AND claim_token IS NOT NULL AND lease_expires_at IS NOT NULL) OR
  (operation='create' AND claim_token IS NULL AND lease_expires_at IS NULL)
 ),
 CHECK(
  (outcome='in_flight' AND completed_at IS NULL AND result_code IS NULL AND observed_trade_no IS NULL AND observed_status IS NULL AND observed_amount_minor IS NULL) OR
  (outcome<>'in_flight' AND completed_at IS NOT NULL)
 ),
 CHECK(operation='query' OR (observed_trade_no IS NULL AND observed_status IS NULL AND observed_amount_minor IS NULL))
);

CREATE INDEX portal_vpay_callback_order_idx ON portal_vpay_callbacks(order_id,received_at,id);
CREATE INDEX portal_vpay_callback_state_idx ON portal_vpay_callbacks(processing_state,received_at,id);
CREATE INDEX portal_vpay_attempt_order_idx ON portal_vpay_attempts(order_id,operation,started_at,id);
CREATE UNIQUE INDEX portal_vpay_single_query_inflight_idx
 ON portal_vpay_attempts(order_id) WHERE operation='query' AND outcome='in_flight';
