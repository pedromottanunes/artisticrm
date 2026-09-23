UPDATE opportunities o
SET channel = CASE
  WHEN EXISTS (
    SELECT 1 FROM inbound_events e
    WHERE e.opportunity_id=o.id AND e.external_id LIKE 'instagram:%'
  ) OR EXISTS (
    SELECT 1 FROM lead_attributions a
    WHERE a.opportunity_id=o.id AND a.channel='instagram'
  ) THEN 'instagram'
  WHEN EXISTS (
    SELECT 1 FROM inbound_events e
    WHERE e.opportunity_id=o.id AND e.external_id LIKE 'whatsapp:%'
  ) OR EXISTS (
    SELECT 1 FROM lead_attributions a
    WHERE a.opportunity_id=o.id AND a.channel='whatsapp'
  ) THEN 'whatsapp'
  ELSE 'manual'
END;
