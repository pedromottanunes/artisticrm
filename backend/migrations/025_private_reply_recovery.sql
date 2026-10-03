ALTER TABLE messages ADD COLUMN private_reply_receipt jsonb;
ALTER TABLE messages ADD COLUMN private_reply_binding_pending boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN private_reply_binding_retry_at timestamptz;
CREATE INDEX messages_private_reply_pending ON messages ((private_reply_receipt->>'account_id'), private_reply_binding_retry_at) WHERE private_reply_binding_pending;
