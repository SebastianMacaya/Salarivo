-- Country corrections use the existing append-only correction history. Original
-- extraction runs retain their observed jurisdiction when the document is reviewed.
ALTER TABLE documents DROP CONSTRAINT documents_country_source_check;
ALTER TABLE documents ADD CONSTRAINT documents_country_source_check
    CHECK (country_source IN ('DOCUMENT_DETECTION', 'EMPLOYMENT_CONFIRMED', 'USER_CONFIRMED'));
ALTER TABLE extraction_runs DROP CONSTRAINT extraction_runs_country_source_check;
ALTER TABLE extraction_runs ADD CONSTRAINT extraction_runs_country_source_check
    CHECK (country_source IN ('DOCUMENT_DETECTION', 'EMPLOYMENT_CONFIRMED', 'USER_CONFIRMED'));
