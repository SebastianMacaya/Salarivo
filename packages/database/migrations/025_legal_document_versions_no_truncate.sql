CREATE TRIGGER legal_document_versions_no_truncate
    BEFORE TRUNCATE ON legal_document_versions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_legal_document_version_mutation();
