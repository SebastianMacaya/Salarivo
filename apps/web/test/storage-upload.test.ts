import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadFile } from '../app/storage-upload.ts';

test('R2 uploads with PUT without trying to set Content-Length', async () => {
  const file = new File(['pdf'], 'receipt.pdf', { type: 'application/pdf' });
  let init: RequestInit | undefined;
  await uploadFile({
    url: 'https://example.invalid/object',
    method: 'PUT',
    fields: {},
    headers: {
      'Content-Length': String(file.size),
      'Content-Type': file.type,
      'If-Match': '"marker-etag"',
      'x-amz-meta-upload-session': 'session-id',
      'x-amz-storage-class': 'STANDARD',
    },
  }, file, async (_input, options) => {
    init = options;
    return new Response(null, { status: 200 });
  });

  const headers = new Headers(init?.headers);
  assert.equal(init?.method, 'PUT');
  assert.equal(headers.get('content-length'), null);
  assert.equal(headers.get('content-type'), 'application/pdf');
  assert.equal(headers.get('if-match'), '"marker-etag"');
  assert.equal(headers.get('x-amz-meta-upload-session'), 'session-id');
  assert.equal(headers.get('x-amz-storage-class'), 'STANDARD');
  assert.equal(init?.body, file);
});

test('AWS and local uploads retain the form POST flow', async () => {
  const file = new File(['pdf'], 'receipt.pdf', { type: 'application/pdf' });
  let init: RequestInit | undefined;
  await uploadFile({
    url: 'https://example.invalid/object',
    method: 'POST',
    fields: { key: 'incoming/object.pdf' },
    headers: {},
  }, file, async (_input, options) => {
    init = options;
    return new Response(null, { status: 204 });
  });

  assert.equal(init?.method, 'POST');
  assert.ok(init?.body instanceof FormData);
  assert.equal(init.body.get('key'), 'incoming/object.pdf');
  assert.equal(init.body.get('file'), file);
});
