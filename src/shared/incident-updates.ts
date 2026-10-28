/**
 * Incident update statuses, shared by the Worker (db/incident-updates.ts, the
 * feeds, MCP) and the app (status page timeline, admin form).
 */
export const INCIDENT_UPDATE_STATUSES = [
  "investigating",
  "identified",
  "monitoring",
  "resolved",
] as const;
export type IncidentUpdateStatus = (typeof INCIDENT_UPDATE_STATUSES)[number];

/** Human labels for each status. */
export const INCIDENT_UPDATE_LABELS: Record<IncidentUpdateStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved",
};
