-- How long the account history (audit_events) is kept (src/audit-retention.ts,
-- the privacy policy, section 4): two years, except the security record of
-- an account that still exists (its support sign-ins, sign-in method changes,
-- key reveals and its creation), kept while the account is.
--
-- Two partial indexes split the table by that list, so the hourly delete is
-- a range scan of the expiring rows by time, and the kept rows are read only
-- by the daily pass that drops those of accounts gone. Their WHERE must stay
-- exactly KEPT_ACTIONS_SQL in src/audit-retention.ts (a test checks the
-- plans use them).
CREATE INDEX idx_audit_events_expiring ON audit_events(at)
  WHERE action NOT IN ('account.created', 'support.handoff_issued', 'tenant.master_key_revealed', 'passkey.added', 'passkey.removed', 'github.linked', 'github.unlinked');
CREATE INDEX idx_audit_events_kept ON audit_events(at)
  WHERE action IN ('account.created', 'support.handoff_issued', 'tenant.master_key_revealed', 'passkey.added', 'passkey.removed', 'github.linked', 'github.unlinked');
