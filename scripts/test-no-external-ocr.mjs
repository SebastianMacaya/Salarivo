// Loaded before automated tests, after Node loads any local .env files.
delete process.env.ZAI_API_KEY;
process.env.OCR_PROVIDER = 'tesseract';
process.env.OCR_ENABLED = 'true';

const localFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.hostname === 'api.z.ai') throw new Error('EXTERNAL_OCR_FORBIDDEN_IN_TESTS');
  return localFetch(input, init);
};
