WITH queue_state AS (
  SELECT count(*)::integer AS last_position
  FROM users
  CROSS JOIN distribution_settings
  WHERE users.role = 'attendant'
    AND users.queue_position IS NOT NULL
    AND users.queue_position <= distribution_settings.last_position
    AND distribution_settings.id = 1
)
UPDATE distribution_settings
SET last_position = queue_state.last_position,
    version = distribution_settings.version + 1
FROM queue_state
WHERE distribution_settings.id = 1;

UPDATE users
SET queue_position = -queue_position
WHERE role = 'attendant' AND queue_position IS NOT NULL;

WITH ranked AS (
  SELECT id,
         (row_number() OVER (ORDER BY queue_position DESC, id))::integer AS queue_position
  FROM users
  WHERE role = 'attendant' AND queue_position IS NOT NULL
)
UPDATE users
SET queue_position = ranked.queue_position,
    queue_credit = 0,
    version = users.version + 1
FROM ranked
WHERE users.id = ranked.id;
