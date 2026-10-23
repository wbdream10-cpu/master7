ALTER TABLE portal_private.portal_payment_orders ADD COLUMN provider_amount_minor BIGINT
 CHECK(provider_amount_minor IS NULL OR (provider_amount_minor>0 AND provider_amount_minor<=10000000))
 CHECK(provider='gspay_myr' OR provider_amount_minor IS NULL);
CREATE UNIQUE INDEX portal_payment_order_gspay_parent_idx ON portal_private.portal_payment_orders(id,provider);

-- Stores only the verified semantic state projected by gspay-contract.mjs.
-- Raw JSON, signature, remark, auth key, secret and reported expiry stay out.
CREATE TABLE portal_private.portal_gspay_callbacks (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL,
 provider TEXT NOT NULL DEFAULT 'gspay_myr' CHECK(provider='gspay_myr'),
 event_key_hash TEXT NOT NULL UNIQUE CHECK(event_key_hash ~ '^[0-9a-f]{64}$'),
 channel TEXT NOT NULL CHECK(channel IN ('payment','duitnow')),
 provider_payment_id TEXT NOT NULL CHECK(length(provider_payment_id)>=1 AND length(provider_payment_id)<=100),
 reported_status TEXT NOT NULL CHECK(reported_status IN ('pending','paid','failed','pending_or_expired','manual_success_review','timeout_or_rejected')),
 amount_minor BIGINT NOT NULL CHECK(amount_minor>0 AND amount_minor<=10000000),
 currency TEXT NOT NULL CHECK(currency='MYR'),
 processing_state TEXT NOT NULL DEFAULT 'pending_query' CHECK(processing_state IN ('pending_query','processed','rejected','review_required')),
 rejection_code TEXT CHECK(rejection_code IS NULL OR (length(rejection_code)>=1 AND length(rejection_code)<=64)),
 received_at TEXT NOT NULL,
 processed_at TEXT,
 FOREIGN KEY(order_id,provider) REFERENCES portal_private.portal_payment_orders(id,provider),
 UNIQUE(id,order_id),
 CHECK(
  (processing_state='pending_query' AND processed_at IS NULL AND rejection_code IS NULL) OR
  (processing_state='processed' AND processed_at IS NOT NULL AND rejection_code IS NULL) OR
  (processing_state IN ('rejected','review_required') AND processed_at IS NOT NULL AND rejection_code IS NOT NULL)
 )
);

CREATE TABLE portal_private.portal_gspay_attempts (
 id TEXT PRIMARY KEY,
 order_id TEXT NOT NULL,
 provider TEXT NOT NULL DEFAULT 'gspay_myr' CHECK(provider='gspay_myr'),
 callback_id TEXT,
 operation TEXT NOT NULL CHECK(operation IN ('create','query')),
 attempt_key TEXT NOT NULL CHECK(length(attempt_key)>=8 AND length(attempt_key)<=100),
 outcome TEXT NOT NULL CHECK(outcome IN ('in_flight','succeeded','failed','unknown')),
 http_status INTEGER CHECK(http_status IS NULL OR (http_status>=100 AND http_status<=599)),
 result_code TEXT CHECK(result_code IS NULL OR (length(result_code)>=1 AND length(result_code)<=64)),
 observed_provider_payment_id TEXT CHECK(observed_provider_payment_id IS NULL OR (length(observed_provider_payment_id)>=1 AND length(observed_provider_payment_id)<=100)),
 observed_status TEXT CHECK(observed_status IS NULL OR observed_status IN ('pending','paid','failed')),
 observed_amount_minor BIGINT CHECK(observed_amount_minor IS NULL OR (observed_amount_minor>0 AND observed_amount_minor<=10000000)),
 started_at TEXT NOT NULL,
 completed_at TEXT,
 FOREIGN KEY(order_id,provider) REFERENCES portal_private.portal_payment_orders(id,provider),
 FOREIGN KEY(callback_id,order_id) REFERENCES portal_private.portal_gspay_callbacks(id,order_id),
 UNIQUE(order_id,operation,attempt_key),
 CHECK(callback_id IS NULL OR operation='query'),
 CHECK(
  (outcome='in_flight' AND completed_at IS NULL AND http_status IS NULL AND result_code IS NULL AND observed_provider_payment_id IS NULL AND observed_status IS NULL AND observed_amount_minor IS NULL) OR
  (outcome<>'in_flight' AND completed_at IS NOT NULL)
 ),
 CHECK(operation='query' OR (observed_provider_payment_id IS NULL AND observed_status IS NULL AND observed_amount_minor IS NULL))
);

CREATE INDEX portal_gspay_callback_order_idx ON portal_private.portal_gspay_callbacks(order_id,received_at,id);
CREATE INDEX portal_gspay_callback_state_idx ON portal_private.portal_gspay_callbacks(processing_state,received_at,id);
CREATE INDEX portal_gspay_attempt_order_idx ON portal_private.portal_gspay_attempts(order_id,operation,started_at,id);

ALTER TABLE portal_private.portal_gspay_callbacks ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_private.portal_gspay_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portal_private.portal_gspay_callbacks,portal_private.portal_gspay_attempts FROM PUBLIC;
DO $gspay_myr_checkout$
DECLARE role_name TEXT;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON portal_private.portal_gspay_callbacks,portal_private.portal_gspay_attempts FROM %I',role_name);
  END IF;
 END LOOP;
END
$gspay_myr_checkout$;
