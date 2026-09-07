-- Receipts already associated before the employment was confirmed inherit its
-- jurisdiction. Existing document snapshots remain immutable evidence.
UPDATE documents AS document
   SET country_code = employment.country_code,
       country_source = 'EMPLOYMENT_CONFIRMED',
       country_confidence = 'HIGH',
       country_snapshot_at = now()
  FROM employments AS employment
 WHERE employment.id = document.employment_id
   AND employment.user_id = document.user_id
   AND employment.country_confirmed_at IS NOT NULL
   AND document.deleted_at IS NULL
   AND document.country_code IS NULL;
