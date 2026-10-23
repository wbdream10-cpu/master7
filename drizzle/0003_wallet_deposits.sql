CREATE TABLE portal_payment_orders (
 id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES portal_users(id),
 request_key TEXT NOT NULL,merchant_id TEXT NOT NULL,environment TEXT NOT NULL CHECK(environment IN ('uat','production')),
 amount_minor INTEGER NOT NULL CHECK(amount_minor>0 AND amount_minor<=10000000),currency TEXT NOT NULL CHECK(currency='MYR'),
 trade_no TEXT,settlement_status TEXT NOT NULL CHECK(settlement_status IN ('created','pending','credited')),
 review_required INTEGER NOT NULL DEFAULT 0 CHECK(review_required IN (0,1)),
 created_at TEXT NOT NULL,verified_at TEXT,credited_at TEXT,
 UNIQUE(user_id,request_key),UNIQUE(merchant_id,environment,trade_no)
);
CREATE TABLE portal_wallet_journal (
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE REFERENCES portal_payment_orders(id),
 tenant_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES portal_users(id),environment TEXT NOT NULL CHECK(environment IN ('uat','production')),
 currency TEXT NOT NULL CHECK(currency='MYR'),member_minor INTEGER NOT NULL CHECK(member_minor>0),
 clearing_minor INTEGER NOT NULL CHECK(clearing_minor<0),created_at TEXT NOT NULL,
 CHECK(member_minor+clearing_minor=0)
);
CREATE TABLE portal_payment_reviews (
 id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES portal_payment_orders(id),tenant_id TEXT NOT NULL,
 reason TEXT NOT NULL,evidence_hash TEXT NOT NULL,created_at TEXT NOT NULL,
 observed_minor TEXT,observed_currency TEXT,observed_state TEXT,observed_trade_no TEXT,
 UNIQUE(order_id,reason,evidence_hash)
);
CREATE INDEX portal_payment_tenant_idx ON portal_payment_orders(tenant_id,created_at DESC,id);
CREATE INDEX portal_payment_member_idx ON portal_payment_orders(tenant_id,user_id,created_at DESC,id);
CREATE INDEX portal_wallet_member_idx ON portal_wallet_journal(tenant_id,user_id,environment,currency);
CREATE INDEX portal_payment_review_idx ON portal_payment_reviews(tenant_id,created_at DESC);
