CREATE TABLE portal_private.portal_withdrawal_requests (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES portal_private.portal_users(id),
 request_key TEXT NOT NULL,
 request_fingerprint TEXT NOT NULL,
 environment TEXT NOT NULL CHECK(environment IN ('uat','production')),
 amount_minor BIGINT NOT NULL CHECK(amount_minor>0 AND amount_minor<=10000000),
 currency TEXT NOT NULL CHECK(currency='MYR'),
 bank_name TEXT NOT NULL,
 account_holder TEXT NOT NULL,
 account_number TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending_review','processing','paid','rejected','failed')),
 payout_reference TEXT,
 resolution_reason TEXT,
 paid_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(user_id,request_key),
 UNIQUE(tenant_id,payout_reference),
 CHECK(
  (status IN ('pending_review','processing') AND payout_reference IS NULL AND resolution_reason IS NULL AND paid_at IS NULL) OR
  (status='paid' AND payout_reference IS NOT NULL AND length(trim(payout_reference))>0 AND resolution_reason IS NULL AND paid_at IS NOT NULL) OR
  (status IN ('rejected','failed') AND payout_reference IS NULL AND resolution_reason IS NOT NULL AND length(trim(resolution_reason))>0 AND paid_at IS NULL)
 )
);

CREATE TABLE portal_private.portal_wallet_holds (
 withdrawal_id TEXT PRIMARY KEY REFERENCES portal_private.portal_withdrawal_requests(id),
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES portal_private.portal_users(id),
 environment TEXT NOT NULL CHECK(environment IN ('uat','production')),
 currency TEXT NOT NULL CHECK(currency='MYR'),
 amount_minor BIGINT NOT NULL CHECK(amount_minor>0 AND amount_minor<=10000000),
 state TEXT NOT NULL CHECK(state IN ('active','released','consumed')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 released_at TEXT,
 consumed_at TEXT,
 CHECK(
  (state='active' AND released_at IS NULL AND consumed_at IS NULL) OR
  (state='released' AND released_at IS NOT NULL AND consumed_at IS NULL) OR
  (state='consumed' AND released_at IS NULL AND consumed_at IS NOT NULL)
 )
);

CREATE TABLE portal_private.portal_wallet_withdrawal_journal (
 id TEXT PRIMARY KEY,
 withdrawal_id TEXT NOT NULL UNIQUE REFERENCES portal_private.portal_withdrawal_requests(id),
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES portal_private.portal_users(id),
 environment TEXT NOT NULL CHECK(environment IN ('uat','production')),
 currency TEXT NOT NULL CHECK(currency='MYR'),
 member_minor BIGINT NOT NULL CHECK(member_minor<0),
 clearing_minor BIGINT NOT NULL CHECK(clearing_minor>0),
 created_at TEXT NOT NULL,
 CHECK(member_minor+clearing_minor=0)
);

CREATE TABLE portal_private.portal_withdrawal_actions (
 id TEXT PRIMARY KEY,
 withdrawal_id TEXT NOT NULL REFERENCES portal_private.portal_withdrawal_requests(id),
 tenant_id TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES portal_private.portal_users(id),
 request_key TEXT NOT NULL,
 request_fingerprint TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('start_processing','mark_paid','reject','fail')),
 reason TEXT,
 payout_reference TEXT,
 created_at TEXT NOT NULL,
 UNIQUE(actor_id,request_key),
 CHECK(
  (action='start_processing' AND reason IS NULL AND payout_reference IS NULL) OR
  (action='mark_paid' AND reason IS NULL AND payout_reference IS NOT NULL AND length(trim(payout_reference))>0) OR
  (action IN ('reject','fail') AND reason IS NOT NULL AND length(trim(reason))>0 AND payout_reference IS NULL)
 )
);

CREATE INDEX portal_withdrawal_tenant_idx ON portal_private.portal_withdrawal_requests(tenant_id,created_at DESC,id);
CREATE INDEX portal_withdrawal_member_idx ON portal_private.portal_withdrawal_requests(tenant_id,user_id,created_at DESC,id);
CREATE INDEX portal_withdrawal_status_idx ON portal_private.portal_withdrawal_requests(tenant_id,status,created_at DESC,id);
CREATE INDEX portal_wallet_hold_member_idx ON portal_private.portal_wallet_holds(tenant_id,user_id,environment,currency,state);
CREATE INDEX portal_wallet_withdrawal_member_idx ON portal_private.portal_wallet_withdrawal_journal(tenant_id,user_id,environment,currency);
CREATE INDEX portal_withdrawal_action_idx ON portal_private.portal_withdrawal_actions(tenant_id,withdrawal_id,created_at,id);

ALTER TABLE portal_private.portal_withdrawal_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_private.portal_wallet_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_private.portal_wallet_withdrawal_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_private.portal_withdrawal_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portal_private.portal_withdrawal_requests,portal_private.portal_wallet_holds,portal_private.portal_wallet_withdrawal_journal,portal_private.portal_withdrawal_actions FROM PUBLIC;
DO $manual_withdrawals$
DECLARE role_name TEXT;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON portal_private.portal_withdrawal_requests,portal_private.portal_wallet_holds,portal_private.portal_wallet_withdrawal_journal,portal_private.portal_withdrawal_actions FROM %I',role_name);
  END IF;
 END LOOP;
END
$manual_withdrawals$;
