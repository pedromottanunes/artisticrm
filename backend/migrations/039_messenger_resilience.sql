-- Page-wide profile backoff survives process restarts and is shared by workers.
ALTER TABLE channel_accounts ADD COLUMN messenger_profile_paused_until timestamptz;
