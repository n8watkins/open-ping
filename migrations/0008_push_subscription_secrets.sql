-- Store a deterministic digest for subscription lookup while allowing the
-- endpoint and Web Push key material to be encrypted with MASTER_KEY.
-- Existing rows remain readable and receive a digest the next time the browser
-- registers the same endpoint.
ALTER TABLE push_subscriptions ADD COLUMN endpoint_hash TEXT;

CREATE UNIQUE INDEX idx_push_subscriptions_endpoint_hash
  ON push_subscriptions(endpoint_hash);
