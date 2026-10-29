-- How long the account history (audit_events) is kept (src/audit-retention.ts,
-- the privacy policy, section 4): two years, except an account's security
-- record (its creation and accepted terms, support sign-ins, key reveals,
-- sign-in method and email changes), kept while the account exists.
--
-- `kept` marks those rows. A trigger sets it on insert, so no writer of
-- audit_events has to know the list; deleting an account clears it for that
-- account's rows, which then expire like any other. The hourly delete is a
-- range scan of a partial index over the rows that may expire, by time, and
-- never reads a kept row.
ALTER TABLE audit_events ADD COLUMN kept INTEGER NOT NULL DEFAULT 0;

-- The list lives here and in KEPT_ACTIONS (src/audit-retention.ts), which a
-- test keeps equal; changing it is a new migration that replaces the trigger.
CREATE TRIGGER audit_events_kept AFTER INSERT ON audit_events
  WHEN NEW.account_id IS NOT NULL AND NEW.action IN (
    'account.created', 'account.email_changed', 'support.handoff_issued', 'tenant.master_key_revealed',
    'passkey.added', 'passkey.removed', 'github.linked', 'github.unlinked')
BEGIN
  UPDATE audit_events SET kept = 1 WHERE id = NEW.id;
END;

UPDATE audit_events SET kept = 1
  WHERE account_id IS NOT NULL AND action IN (
    'account.created', 'account.email_changed', 'support.handoff_issued', 'tenant.master_key_revealed',
    'passkey.added', 'passkey.removed', 'github.linked', 'github.unlinked');

CREATE INDEX idx_audit_events_expiring ON audit_events(at) WHERE kept = 0;
