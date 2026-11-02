ALTER TABLE contact_identities ADD COLUMN profile_last_error text;

-- Recover lookups abandoned by the previous worker, without changing lead ownership.
UPDATE contact_identities ci
SET profile_pending=true, profile_check_after='1970-01-01T00:00:00Z'
FROM contacts c
WHERE ci.contact_id=c.id AND ci.provider='messenger'
  AND c.name='Contato Messenger' AND NOT ci.profile_pending;
