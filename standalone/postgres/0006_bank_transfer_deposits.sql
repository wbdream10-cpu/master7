CREATE TABLE portal_private.portal_bank_accounts (
 tenant_id TEXT PRIMARY KEY,
 bank_name TEXT NOT NULL,
 account_holder TEXT NOT NULL,
 account_number TEXT NOT NULL,
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
 updated_by TEXT NOT NULL REFERENCES portal_private.portal_users(id),
 updated_at TEXT NOT NULL
);
CREATE TABLE portal_private.portal_finance_staff (
 user_id TEXT PRIMARY KEY REFERENCES portal_private.portal_users(id),
 tenant_id TEXT NOT NULL,
 granted_by TEXT NOT NULL REFERENCES portal_private.portal_users(id),
 granted_at TEXT NOT NULL
);
CREATE TABLE portal_private.portal_bank_deposits (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES portal_private.portal_users(id),
 request_key TEXT NOT NULL,
 request_fingerprint TEXT NOT NULL,
 amount_minor BIGINT NOT NULL CHECK(amount_minor>0 AND amount_minor<=10000000),
 currency TEXT NOT NULL CHECK(currency='MYR'),
 payer_name TEXT NOT NULL,
 transfer_reference TEXT NOT NULL,
 transferred_at TEXT NOT NULL,
 recipient_bank_name TEXT NOT NULL,
 recipient_account_holder TEXT NOT NULL,
 recipient_account_number TEXT NOT NULL,
 bank_config_updated_at TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('awaiting_review','approved','rejected')),
 receipt_mime TEXT CHECK(receipt_mime IN ('image/jpeg','image/png','image/webp')),
 receipt_bytes BYTEA,
 receipt_size INTEGER CHECK(receipt_size IS NULL OR (receipt_size>0 AND receipt_size<=2097152)),
 receipt_sha256 TEXT,
 receipt_uploaded_at TEXT,
 review_request_key TEXT,
 review_fingerprint TEXT,
 review_decision TEXT CHECK(review_decision IS NULL OR review_decision IN ('approve','reject')),
 review_reason TEXT,
 reviewed_by TEXT REFERENCES portal_private.portal_users(id),
 reviewed_at TEXT,
 wallet_order_id TEXT UNIQUE REFERENCES portal_private.portal_payment_orders(id) DEFERRABLE INITIALLY DEFERRED,
 created_at TEXT NOT NULL,
 UNIQUE(user_id,request_key),
 UNIQUE(tenant_id,transfer_reference),
 UNIQUE(reviewed_by,review_request_key),
 CHECK((receipt_mime IS NULL AND receipt_bytes IS NULL AND receipt_size IS NULL AND receipt_sha256 IS NULL AND receipt_uploaded_at IS NULL) OR
       (receipt_mime IS NOT NULL AND receipt_bytes IS NOT NULL AND receipt_size IS NOT NULL AND receipt_sha256 IS NOT NULL AND receipt_uploaded_at IS NOT NULL)),
 CHECK((status='awaiting_review' AND review_request_key IS NULL AND review_fingerprint IS NULL AND review_decision IS NULL AND review_reason IS NULL AND reviewed_by IS NULL AND reviewed_at IS NULL AND wallet_order_id IS NULL) OR
       (status='approved' AND receipt_sha256 IS NOT NULL AND review_request_key IS NOT NULL AND review_fingerprint IS NOT NULL AND review_decision='approve' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND wallet_order_id IS NOT NULL) OR
       (status='rejected' AND review_request_key IS NOT NULL AND review_fingerprint IS NOT NULL AND review_decision='reject' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL AND wallet_order_id IS NULL))
);
CREATE INDEX portal_bank_deposit_tenant_idx ON portal_private.portal_bank_deposits(tenant_id,created_at DESC,id);
CREATE INDEX portal_bank_deposit_member_idx ON portal_private.portal_bank_deposits(tenant_id,user_id,created_at DESC,id);
CREATE INDEX portal_bank_deposit_status_idx ON portal_private.portal_bank_deposits(tenant_id,status,created_at DESC,id);
CREATE INDEX portal_finance_staff_tenant_idx ON portal_private.portal_finance_staff(tenant_id,user_id);
ALTER TABLE portal_private.portal_bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_private.portal_finance_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_private.portal_bank_deposits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portal_private.portal_bank_accounts,portal_private.portal_finance_staff,portal_private.portal_bank_deposits FROM PUBLIC;
DO $bank_transfer$
DECLARE role_name TEXT;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON portal_private.portal_bank_accounts,portal_private.portal_finance_staff,portal_private.portal_bank_deposits FROM %I',role_name);
  END IF;
 END LOOP;
END
$bank_transfer$;
