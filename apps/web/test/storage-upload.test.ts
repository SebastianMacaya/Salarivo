import assert from 'node:assert/strict';
import test from 'node:test';
import { uploadFile } from '../app/storage-upload.ts';

class FakeRequest {
  status = 0;
  method = '';
  url = '';
  headers = new Headers();
  body: Document | XMLHttpRequestBodyInit | null = null;
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
  send(body: Document | XMLHttpRequestBodyInit | null = null) { this.body = body; }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  }
  finish(status: number) { this.status = status; this.onload?.(); }
}

test('R2 uploads with PUT without trying to set Content-Length', async () => {
  const file = new File(['pdf'], 'receipt.pdf', { type: 'application/pdf' });
  const request = new FakeRequest();
  const percentages: number[] = [];
  const result = uploadFile({
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
  }, file, (percentage) => percentages.push(percentage), request as unknown as XMLHttpRequest);

  request.progress(3, 4);
  request.finish(200);

  assert.deepEqual(await result, { ok: true, status: 200 });
  assert.equal(request.method, 'PUT');
  assert.equal(request.url, 'https://example.invalid/object');
  assert.equal(request.headers.get('content-length'), null);
  assert.equal(request.headers.get('content-type'), 'application/pdf');
  assert.equal(request.headers.get('if-match'), '"marker-etag"');
  assert.equal(request.headers.get('x-amz-meta-upload-session'), 'session-id');
  assert.equal(request.headers.get('x-amz-storage-class'), 'STANDARD');
  assert.equal(request.body, file);
  assert.deepEqual(percentages, [75]);
});

test('AWS and local uploads retain the form POST flow', async () => {
  const file = new File(['pdf'], 'receipt.pdf', { type: 'application/pdf' });
  const request = new FakeRequest();
  const result = uploadFile({
    url: 'https://example.invalid/object',
    method: 'POST',
    fields: { key: 'incoming/object.pdf' },
    headers: {},
  }, file, undefined, request as unknown as XMLHttpRequest);

  request.finish(204);

  assert.deepEqual(await result, { ok: true, status: 204 });
  assert.equal(request.method, 'POST');
  assert.ok(request.body instanceof FormData);
  assert.equal(request.body.get('key'), 'incoming/object.pdf');
  assert.equal(request.body.get('file'), file);
});
