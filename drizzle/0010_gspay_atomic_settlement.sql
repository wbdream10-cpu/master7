ALTER TABLE portal_payment_orders ADD COLUMN provider_player_username TEXT
 CHECK(provider_player_username IS NULL OR (
  length(provider_player_username)>=3 AND length(provider_player_username)<=40 AND
  provider_player_username=lower(provider_player_username) AND
  provider_player_username NOT GLOB '*[^a-z0-9_-]*'
 ))
 CHECK(provider='gspay_myr' OR provider_player_username IS NULL);

-- A process-local queue cannot serialize two portal instances. A failed or
-- timed-out attempt must leave in_flight before a retry can begin.
CREATE UNIQUE INDEX portal_gspay_single_query_inflight_idx
 ON portal_gspay_attempts(order_id)
 WHERE operation='query' AND outcome='in_flight';
