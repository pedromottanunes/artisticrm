ALTER TABLE contacts
ADD COLUMN residence_city text NOT NULL DEFAULT '';

ALTER TABLE opportunities
ADD COLUMN consultation_status text NOT NULL DEFAULT 'NOT_SCHEDULED'
  CHECK (consultation_status IN ('NOT_SCHEDULED','SCHEDULED','ATTENDED','NO_SHOW','CANCELLED')),
ADD COLUMN sale_completed_at timestamptz,
ADD COLUMN sale_seller_name text NOT NULL DEFAULT '',
ADD COLUMN consultant text NOT NULL DEFAULT '',
ADD COLUMN total_value_cents integer CHECK (total_value_cents IS NULL OR total_value_cents >= 0),
ADD COLUMN down_payment_cents integer CHECK (down_payment_cents IS NULL OR down_payment_cents >= 0),
ADD COLUMN hair_grade_classification text NOT NULL DEFAULT '',
ADD COLUMN has_pack boolean,
ADD COLUMN contract_status text CHECK (contract_status IS NULL OR contract_status IN ('awaiting','signed','not_signed'));

ALTER TABLE appointments DROP CONSTRAINT appointments_status_check;

UPDATE appointments SET status='attended' WHERE status='completed';

ALTER TABLE appointments
ADD CONSTRAINT appointments_status_check
CHECK (status IN ('scheduled','attended','no_show','cancelled'));

UPDATE opportunities o
SET consultation_status = CASE (
  SELECT a.status
  FROM appointments a
  WHERE a.opportunity_id=o.id
  ORDER BY a.starts_at DESC,a.id DESC
  LIMIT 1
)
  WHEN 'scheduled' THEN 'SCHEDULED'
  WHEN 'attended' THEN 'ATTENDED'
  WHEN 'no_show' THEN 'NO_SHOW'
  WHEN 'cancelled' THEN 'CANCELLED'
  ELSE 'NOT_SCHEDULED'
END;

UPDATE opportunities
SET sale_completed_at=created_at,
    contract_status=CASE WHEN stage='CONTRACT_PENDING' THEN 'awaiting' ELSE contract_status END
WHERE stage IN ('CONTRACT_PENDING','CLOSED_WITH_DATE','CLOSED_WITHOUT_DATE');
