import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { publishedLegalDocuments } from '../app/legal-documents.ts';

test('publica textos legales cerrados y sincronizados con la migración', async () => {
  const migration = await readFile(
    new URL('../../../packages/database/migrations/013_google_identity_foundation.sql', import.meta.url),
    'utf8',
  );
  for (const document of Object.values(publishedLegalDocuments)) {
    assert.equal(document.version, '1.0');
    assert.doesNotMatch(document.content, /BORRADOR|(?:^|\s)TODO(?:\s|$)|completar|revisión legal antes de producción/i);
    assert.match(document.title, /acceso privado individual/i);
    assert.ok(migration.includes(document.content));
  }
  assert.match(publishedLegalDocuments.terms.content, /derechos inderogables/i);
  assert.match(publishedLegalDocuments.privacy.content, /diez días corridos/i);
  assert.match(publishedLegalDocuments.privacy.content, /cinco días hábiles/i);
  assert.match(publishedLegalDocuments.privacy.content, /cookie técnica transitoria/i);
  assert.match(publishedLegalDocuments.privacy.content, /no se persisten access tokens, refresh tokens ni ID tokens/i);
});
