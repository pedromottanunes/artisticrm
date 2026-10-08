ALTER TABLE opportunities ADD COLUMN pack_quantity integer
  CHECK (pack_quantity IS NULL OR pack_quantity BETWEEN 0 AND 10000);

-- Keep the latest owned record operational, without reactivating older duplicates.
UPDATE opportunities o SET state='CLAIMED',version=version+1
WHERE o.state='CANCELLED' AND o.owner_id IS NOT NULL
AND o.stage IN ('CONTRACT_PENDING','CLOSED_WITH_DATE','CLOSED_WITHOUT_DATE','DECLINED')
AND NOT EXISTS (SELECT 1 FROM opportunities active
  WHERE active.contact_id=o.contact_id AND active.state<>'CANCELLED')
AND NOT EXISTS (SELECT 1 FROM opportunities newer
  WHERE newer.contact_id=o.contact_id AND (newer.created_at,newer.id)>(o.created_at,o.id));

DROP INDEX one_active_opportunity;
CREATE UNIQUE INDEX one_active_opportunity ON opportunities(contact_id)
WHERE state<>'CANCELLED';
