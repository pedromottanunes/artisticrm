ALTER TABLE opportunities DROP CONSTRAINT opportunities_stage_check;

ALTER TABLE opportunities
ADD CONSTRAINT opportunities_stage_check
CHECK (stage IN ('NEW_LEAD','CONSULTATION_NOT_SCHEDULED','FOLLOW_UP','CONTRACT_PENDING','CLOSED_WITH_DATE','CLOSED_WITHOUT_DATE','DECLINED'));

ALTER TABLE opportunities ALTER COLUMN stage SET DEFAULT 'NEW_LEAD';

ALTER TABLE opportunities DROP CONSTRAINT opportunities_consultation_status_check;

ALTER TABLE opportunities
ADD CONSTRAINT opportunities_consultation_status_check
CHECK (consultation_status IN ('UNDEFINED','NOT_SCHEDULED','SCHEDULED','ATTENDED','NO_SHOW','CANCELLED'));

ALTER TABLE opportunities ALTER COLUMN consultation_status SET DEFAULT 'UNDEFINED';

UPDATE opportunities
SET stage='NEW_LEAD', consultation_status='UNDEFINED'
WHERE stage='CONSULTATION_NOT_SCHEDULED';
