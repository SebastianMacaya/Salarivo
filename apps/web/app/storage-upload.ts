export type AuthorizedUpload = {
  url: string;
  method: 'POST' | 'PUT';
  fields: Record<string, string>;
  headers: Record<string, string>;
};

export async function uploadFile(
  upload: AuthorizedUpload,
  file: File,
  request: typeof fetch = fetch,
): Promise<Response> {
  if (upload.method === 'PUT') {
    const headers = new Headers(upload.headers);
    headers.delete('content-length');
    return request(upload.url, { method: 'PUT', headers, body: file });
  }

  const form = new FormData();
  Object.entries(upload.fields).forEach(([name, value]) => form.append(name, value));
  form.append('file', file);
  return request(upload.url, { method: 'POST', body: form });
}
