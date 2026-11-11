-- 0030: The Hosted waitlist becomes double opt-in (docs/HOSTED_PLAN.md, stage 1).
--
-- A new sign-up starts pending (confirmed_at NULL) with an expires_at seven days
-- out; it becomes confirmed when its owner opens the link in the confirm email,
-- and a pending row that is never confirmed is deleted after that.
--
-- Rows from before this migration joined when a sign-up was a single step and
-- got a thank-you, so they count as confirmed from the day they joined and
-- never expire.
ALTER TABLE waitlist ADD COLUMN confirmed_at INTEGER;
ALTER TABLE waitlist ADD COLUMN expires_at INTEGER;
UPDATE waitlist SET confirmed_at = created_at;

-- The daily cleanup of pending rows past their expiry.
CREATE INDEX idx_waitlist_pending ON waitlist(expires_at) WHERE confirmed_at IS NULL;

-- The links in the emails. Only the SHA-256 of a token is stored. A 'confirm'
-- token is single use (used_at) and expires with the pending row; a 'leave'
-- token has no expiry, because every email carries one. Leaving deletes the
-- waitlist row, and its tokens go with it.
CREATE TABLE waitlist_tokens (
  token_hash  TEXT PRIMARY KEY,
  waitlist_id TEXT NOT NULL REFERENCES waitlist(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('confirm', 'leave')),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  used_at     INTEGER
);

CREATE INDEX idx_waitlist_tokens_waitlist ON waitlist_tokens(waitlist_id);
