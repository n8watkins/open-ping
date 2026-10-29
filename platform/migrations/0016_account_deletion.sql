-- Deleting an account (src/account-deletion.ts): the customer from their
-- account page, or the owner for a support request. The request stops the
-- account's OpenPing at once; the lifecycle jobs then export it, delete it
-- (decisions D8 and D12), and finally scrub the account: its sign-in
-- methods, sessions and email go, and the row stays, anonymous, only because
-- the billing records the law makes us keep (subscriptions) point at it.
ALTER TABLE accounts ADD COLUMN deletion_requested_at INTEGER;
-- 'customer' or 'owner'.
ALTER TABLE accounts ADD COLUMN deletion_requested_by TEXT;
ALTER TABLE accounts ADD COLUMN deleted_at INTEGER;
-- The lifecycle job reads only the deletions still in progress.
CREATE INDEX idx_accounts_deleting ON accounts(deletion_requested_at) WHERE deletion_requested_at IS NOT NULL AND deleted_at IS NULL;
