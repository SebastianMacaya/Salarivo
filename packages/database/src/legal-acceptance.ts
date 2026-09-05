// Use the same current-version rule for authenticated access and paid OCR admission.
export function currentLegalAcknowledgementsSql(userAlias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(userAlias)) throw new Error("INVALID_SQL_ALIAS");
  return `(
    SELECT count(*) = 2
      FROM (
        SELECT DISTINCT ON (version.document_type) version.id
          FROM legal_document_versions AS version
         WHERE version.document_type IN ('TERMS', 'PRIVACY_NOTICE')
           AND version.locale = 'es-AR'
           AND version.published_at <= now() AND version.effective_at <= now()
         ORDER BY version.document_type, version.effective_at DESC,
                  split_part(version.version, '.', 1)::numeric DESC,
                  split_part(version.version, '.', 2)::numeric DESC,
                  version.published_at DESC
      ) AS current_version
      JOIN legal_acknowledgements AS acknowledgement
        ON acknowledgement.document_version_id = current_version.id
       AND acknowledgement.user_id = ${userAlias}.id
  )`;
}
