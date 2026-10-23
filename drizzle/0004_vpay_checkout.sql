ALTER TABLE portal_payment_orders ADD COLUMN create_outcome TEXT NOT NULL DEFAULT 'not_sent' CHECK(create_outcome IN ('not_sent','in_flight','unknown','created'));
ALTER TABLE portal_payment_orders ADD COLUMN create_attempted_at TEXT;
ALTER TABLE portal_payment_orders ADD COLUMN create_fingerprint TEXT;
ALTER TABLE portal_payment_orders ADD COLUMN trade_code TEXT;
ALTER TABLE portal_payment_orders ADD COLUMN checkout_url TEXT;
ALTER TABLE portal_payment_orders ADD COLUMN expires_at_raw TEXT;
