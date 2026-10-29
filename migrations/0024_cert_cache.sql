-- 0024: Cache each SSL certificate monitor's last read.
-- monitor_state.cert_cache: JSON written by the check path (checks/cert.ts
-- CertCache): the host and port it belongs to, when it was read, and what the
-- read found (the certificate's issuer, validity and names, or why it can't be
-- read from a Worker), after a failed read when to try again and why it failed,
-- and the smallest warning threshold already alerted for that certificate. A
-- certificate monitor judges its expiry from this most cycles instead of
-- connecting every 12 minutes. NULL for other monitor types and for
-- certificate monitors not yet read.
ALTER TABLE monitor_state ADD COLUMN cert_cache TEXT;
