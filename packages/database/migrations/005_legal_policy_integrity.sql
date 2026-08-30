ALTER TABLE legal_document_versions
    ADD COLUMN approved_for_production boolean NOT NULL DEFAULT false;

ALTER TABLE legal_acceptances RENAME TO legal_acknowledgements;
ALTER INDEX legal_acceptances_version_idx RENAME TO legal_acknowledgements_version_idx;

CREATE FUNCTION reject_legal_document_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $body$
BEGIN
    RAISE EXCEPTION 'legal document versions are append-only';
END;
$body$;

CREATE TRIGGER legal_document_versions_append_only
    BEFORE UPDATE OR DELETE ON legal_document_versions
    FOR EACH ROW EXECUTE FUNCTION reject_legal_document_version_mutation();
