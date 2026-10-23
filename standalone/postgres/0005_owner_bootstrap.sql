CREATE UNIQUE INDEX IF NOT EXISTS portal_users_single_owner
ON portal_private.portal_users(role)
WHERE role='owner';
