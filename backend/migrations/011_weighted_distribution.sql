ALTER TABLE users
  ADD COLUMN queue_weight smallint NOT NULL DEFAULT 1 CHECK (queue_weight BETWEEN 1 AND 3),
  ADD COLUMN queue_credit integer NOT NULL DEFAULT 0;
