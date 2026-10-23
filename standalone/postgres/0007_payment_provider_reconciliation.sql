ALTER TABLE portal_private.portal_payment_orders ADD COLUMN provider TEXT NOT NULL DEFAULT 'unknown' CHECK(provider IN ('vpay','gspay_myr','bank_transfer','unknown'));
UPDATE portal_private.portal_payment_orders SET provider=CASE WHEN merchant_id='manual_bank' THEN 'bank_transfer' ELSE 'vpay' END;
