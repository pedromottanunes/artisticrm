CREATE TABLE instagram_comments (
  id uuid PRIMARY KEY,
  account_id text NOT NULL,
  comment_id text NOT NULL,
  sender_id text NOT NULL,
  username text NOT NULL DEFAULT '',
  text text NOT NULL DEFAULT '',
  media_id text NOT NULL DEFAULT '',
  permalink text NOT NULL DEFAULT '',
  thumbnail_url text NOT NULL DEFAULT '',
  preview_checked_at timestamptz,
  created_at timestamptz NOT NULL,
  reply_deadline_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  ignored boolean NOT NULL DEFAULT false,
  opportunity_id uuid,
  conversation_id uuid,
  claimed_by uuid,
  version integer NOT NULL DEFAULT 1,
  UNIQUE(account_id, comment_id)
);
CREATE INDEX instagram_comments_pool ON instagram_comments(account_id, ignored, received_at DESC, id);
CREATE INDEX instagram_comments_sender ON instagram_comments(account_id, sender_id);
CREATE INDEX instagram_comments_opportunity ON instagram_comments(opportunity_id);
CREATE INDEX instagram_comments_preview ON instagram_comments(account_id, received_at DESC) WHERE preview_checked_at IS NULL;
ALTER TABLE conversations ADD COLUMN private_reply_comment_id text;
ALTER TABLE conversations ADD COLUMN private_reply_message_id uuid;
ALTER TABLE conversations ADD COLUMN private_reply_started_at timestamptz;
ALTER TABLE conversations ADD COLUMN instagram_recipient_id text;
