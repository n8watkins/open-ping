-- Incident updates: the timeline of status posts an admin writes for an
-- incident ("Investigating", "Identified", "Monitoring", "Resolved", each with
-- a message), shown on the public status page and in its RSS and Atom feeds
-- while the incident itself is public. Additive only: incidents.public_message
-- stays as the incident's summary and nothing existing is migrated.
--
-- A new table, so the status enum can be a real CHECK constraint. Deleting an
-- incident (or its monitor) deletes its updates.

CREATE TABLE incident_updates (
  id          TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status      TEXT NOT NULL
              CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
  message     TEXT NOT NULL,
  posted_at   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_incident_updates_incident ON incident_updates(incident_id, posted_at);
