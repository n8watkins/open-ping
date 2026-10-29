-- The Terms of Service each account accepted (plan item D3): the version
-- (the "Last updated" date of docs/legal/TERMS.md, src/legal/documents.ts)
-- and when, written once when the account is made. Accounts made before
-- this migration have none, and accepted no recorded version.
--
-- 0011 because PR #71 (observability) adds 0010; the two are independent
-- and apply in either order.
ALTER TABLE accounts ADD COLUMN terms_version TEXT;
ALTER TABLE accounts ADD COLUMN terms_accepted_at INTEGER;
