export type AuthorizedUpload = {
  url: string;
  method: 'POST' | 'PUT';
  fields: Record<string, string>;
  headers: Record<string, string>;
};

export function uploadFile(
  upload: AuthorizedUpload,
  file: File,
  onProgress: (percentage: number) => void = () => undefined,
  request: XMLHttpRequest = new XMLHttpRequest(),
): Promise<{ ok: boolean; status: number }> {
  return new Promise((resolve, reject) => {
    request.open(upload.method, upload.url);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded * 100) / event.total)));
      }
    };
    request.onload = () => resolve({ ok: request.status >= 200 && request.status < 300, status: request.status });
    request.onerror = () => reject(new Error('Se interrumpió la conexión con el almacenamiento.'));
    request.onabort = () => reject(new Error('La carga fue cancelada.'));

    if (upload.method === 'PUT') {
      Object.entries(upload.headers).forEach(([name, value]) => {
        if (name.toLowerCase() !== 'content-length') request.setRequestHeader(name, value);
      });
      request.send(file);
      return;
    }

    const form = new FormData();
    Object.entries(upload.fields).forEach(([name, value]) => form.append(name, value));
    form.append('file', file);
    request.send(form);
  });
}
