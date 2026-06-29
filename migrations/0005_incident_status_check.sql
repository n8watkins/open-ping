-- Defense-in-depth for the incidents.status enum that the partial unique index
-- idx_incidents_one_open (WHERE status = 'open') depends on. A stray value such
-- as 'Open' would silently escape that index and allow a second open incident
-- per monitor.
--
-- SQLite cannot add a CHECK constraint to an existing column without a full table
-- rebuild (create-copy-drop-rename), which is risky to ship. Instead we emulate
-- the CHECK with BEFORE INSERT/UPDATE triggers that reject any status other than
-- the two values the app ever writes ('open' on openIncident, 'resolved' on
-- resolveIncident). This adds the backstop without touching existing rows.
--
-- (Other enum columns — monitor_state.state, monitors.type — are constrained by
-- the worker's TypeScript types and have no index dependency, so they are left to
-- the app layer; only the index-backing status column gets a DB-level guard.)

CREATE TRIGGER incidents_status_valid_insert
BEFORE INSERT ON incidents
FOR EACH ROW WHEN NEW.status NOT IN ('open', 'resolved')
BEGIN
  SELECT RAISE(ABORT, 'invalid incidents.status (must be open or resolved)');
END;

CREATE TRIGGER incidents_status_valid_update
BEFORE UPDATE OF status ON incidents
FOR EACH ROW WHEN NEW.status NOT IN ('open', 'resolved')
BEGIN
  SELECT RAISE(ABORT, 'invalid incidents.status (must be open or resolved)');
END;
