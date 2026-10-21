-- New empty portal only. No users, tenants, content, connections or events are seeded.
CREATE SCHEMA IF NOT EXISTS portal_private;
REVOKE ALL ON SCHEMA portal_private FROM PUBLIC;
CREATE TABLE IF NOT EXISTS portal_private.schema_versions(name TEXT PRIMARY KEY,hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS portal_private.audit(id TEXT PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL,tenant_id TEXT NOT NULL DEFAULT 'main');
CREATE TABLE IF NOT EXISTS portal_private.notices(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),created_at TEXT NOT NULL,tenant_id TEXT NOT NULL DEFAULT 'main');
CREATE TABLE IF NOT EXISTS portal_private.tickets(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT '待处理',reply TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,tenant_id TEXT NOT NULL DEFAULT 'main');
CREATE TABLE IF NOT EXISTS portal_private.brands(id TEXT PRIMARY KEY,name TEXT NOT NULL,tagline TEXT NOT NULL DEFAULT '欢迎来到服务中心',color TEXT NOT NULL DEFAULT '#2165e8',logo TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS portal_private.members(email TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS portal_private.portal_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE CHECK(username=lower(username)),email TEXT NOT NULL UNIQUE CHECK(email=lower(email)),password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','customer')),approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN (0,1)),recovery_hash TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS portal_private.portal_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES portal_private.portal_users(id),expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS portal_private.portal_rate_limits(bucket TEXT PRIMARY KEY,attempts INTEGER NOT NULL,expires_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS portal_private.portal_staff(user_id TEXT PRIMARY KEY REFERENCES portal_private.portal_users(id),tenant_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('tenant_owner','employee')));
CREATE TABLE IF NOT EXISTS portal_private.portal_connections(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,key_env TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS portal_private.portal_events(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES portal_private.portal_connections(id),event_id TEXT NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,received_at TEXT NOT NULL,UNIQUE(connection_id,event_id));
CREATE TABLE IF NOT EXISTS portal_private.portal_deposit_requests(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES portal_private.portal_users(id),amount_minor INTEGER NOT NULL CHECK(amount_minor>0 AND amount_minor<=10000000),currency TEXT NOT NULL CHECK(currency='MYR'),status TEXT NOT NULL CHECK(status='awaiting_connection'),request_key TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(user_id,request_key));
CREATE INDEX IF NOT EXISTS portal_sessions_user_idx ON portal_private.portal_sessions(user_id);
CREATE INDEX IF NOT EXISTS portal_sessions_expiry_idx ON portal_private.portal_sessions(expires_at);
CREATE INDEX IF NOT EXISTS portal_rate_limits_expiry_idx ON portal_private.portal_rate_limits(expires_at);
CREATE INDEX IF NOT EXISTS portal_notices_tenant_idx ON portal_private.notices(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS portal_tickets_tenant_idx ON portal_private.tickets(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS portal_tickets_user_idx ON portal_private.tickets(tenant_id,user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS portal_audit_tenant_idx ON portal_private.audit(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS portal_members_tenant_idx ON portal_private.members(tenant_id);
CREATE INDEX IF NOT EXISTS portal_deposit_tenant_idx ON portal_private.portal_deposit_requests(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS portal_deposit_user_idx ON portal_private.portal_deposit_requests(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS portal_events_received_idx ON portal_private.portal_events(received_at DESC);
-- Closed to Data API/browser roles. Backend table owner enforces platform sessions and tenant scope.
DO $portal$
DECLARE item RECORD; role_name TEXT;
BEGIN
 FOR item IN SELECT tablename FROM pg_tables WHERE schemaname='portal_private' LOOP
  EXECUTE format('ALTER TABLE portal_private.%I ENABLE ROW LEVEL SECURITY',item.tablename);
  EXECUTE format('REVOKE ALL ON TABLE portal_private.%I FROM PUBLIC',item.tablename);
 END LOOP;
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('REVOKE ALL ON SCHEMA portal_private FROM %I',role_name);
   EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA portal_private FROM %I',role_name);
  END IF;
 END LOOP;
END
$portal$;
