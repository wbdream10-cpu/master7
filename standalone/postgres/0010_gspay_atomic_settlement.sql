ALTER TABLE portal_private.portal_payment_orders ADD COLUMN provider_player_username TEXT
 CHECK(provider_player_username IS NULL OR provider_player_username ~ '^[a-z0-9_-]{3,40}$')
 CHECK(provider='gspay_myr' OR provider_player_username IS NULL);

-- Enforce one independent provider query claim per order across every portal
-- instance. Completed attempts do not block a later retry.
CREATE UNIQUE INDEX portal_gspay_single_query_inflight_idx
 ON portal_private.portal_gspay_attempts(order_id)
 WHERE operation='query' AND outcome='in_flight';
