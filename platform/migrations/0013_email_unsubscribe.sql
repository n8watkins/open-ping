-- One-click unsubscribe for the people a customer's OpenPing emails
-- (src/recipients.ts): each confirmed address gets a random token, made the
-- first time it is mailed, which its unsubscribe link and the
-- List-Unsubscribe header carry. Using it moves the address to 'declined'
-- and clears the token.
--
-- Unlike the confirmation link's token, this one is kept as it is, not as a
-- hash, because every email to the address carries it again; all it can do
-- is stop that address's email from that one OpenPing.
ALTER TABLE email_recipients ADD COLUMN unsubscribe_token TEXT;
CREATE UNIQUE INDEX idx_email_recipients_unsubscribe ON email_recipients(unsubscribe_token) WHERE unsubscribe_token IS NOT NULL;
