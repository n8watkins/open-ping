-- How a session came to be, beyond its sign-in method (identity_kind):
-- 'app' for a session the OpenPing Android app redeemed from a browser
-- sign-in (src/worker/routes/app-signin.ts), so Settings can list the app's
-- sessions on their own and the owner can sign any of them out. NULL for
-- every other session, including all of them before this migration.
ALTER TABLE sessions ADD COLUMN via TEXT;
