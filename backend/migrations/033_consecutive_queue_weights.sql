ALTER TABLE users DROP CONSTRAINT IF EXISTS users_queue_weight_check;

ALTER TABLE users
  ADD CONSTRAINT users_queue_weight_check CHECK (queue_weight BETWEEN 1 AND 5);

UPDATE users SET queue_credit = 0 WHERE role = 'attendant';
