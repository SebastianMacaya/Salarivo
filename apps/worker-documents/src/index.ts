import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  compareProcessingSnapshots,
  criticalFieldsBySettlementType,
  currentPipelineFingerprint,
  EmployerResolutionError,
  followMergedEmployer,
  lockEmployerMutation,
  migrate,
  pool,
  processingPipelineVersions,
  resolveEmployer,
  withTransaction,
  type ProcessingSnapshot,
  type ProcessingTriggerKind,
} from '@salarivo/database';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { PoolClient } from 'pg';
import { createClient } from 'redis';
import {
  applySettlementCorrections,
  attachSpatialEvidence,
  classifyPayrollText,
  extractArgentinePayroll,
  hasPdfMagic,
  parseJobMessage,
  parseTextEvidenceTsv,
  payrollExtractionNeedsReview,
  pendingUploadCutoff,
  selectDispatchCandidates,
  textFromEvidencePages,
  uploadCleanupStatus,
  validatePdfInfo,
  validateRenderPixels,
  type Classification,
  type FieldSource,
  type PayrollExtraction,
  type TextEvidencePage,
} from './engine.ts';
import { runtimeEnvironment, type RuntimeEnvironment } from './environment.ts';
import {
  assertProductionStorageConfig,
  objectStorageProvider,
  verifyProductionStorage,
  type StorageProvider,
} from './storage.ts';

const QUEUE_NAME = 'salarivo:processing-jobs:documents';
const STORAGE_REQUEST_TIMEOUT_MS = 30_000;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
let startupStage = 'configuration';

type WorkerConfig = {
  appEnv: RuntimeEnvironment;
  clamavHost: string;
  clamavPort: number;
  classificationHighThreshold: number;
  classificationLowThreshold: number;
  cloudflareAccountId: string | null;
  cloudflareApiToken: string | null;
  dispatcherBatchSize: number;
  dispatcherPollMs: number;
  jobLeaseMs: number;
  maxFileBytes: number;
  maxOcrPages: number;
  maxOcrTimeMs: number;
  maxPages: number;
  maxParseTimeMs: number;
  maxRenderPixels: number;
  maxTextBytes: number;
  publishedRetryMs: number;
  publicOrigin: string | null;
  queueUrl: string;
  storageAccessKey: string;
  storageBucket: string;
  storageDeleteVerifyDelayMs: number;
  storageEndpoint: string;
  storageKmsKeyId: string | null;
  storageProvider: StorageProvider;
  storageRegion: string;
  storageSecretKey: string;
  uploadCleanupGraceMs: number;
  uploadTtlMs: number;
  workerConcurrency: number;
  workerConcurrencyPerUser: number;
};

export type JobRow = {
  attempt: number;
  base_extraction_run_id?: string | null;
  document_id: string;
  id: string;
  lease_owner: string;
  max_attempts: number;
  pipeline_fingerprint?: string | null;
  previous_document_status: 'COMPLETED' | 'NEEDS_REVIEW' | 'FAILED_PERMANENT' | 'CANCELLED' | null;
  processing_version: number;
  reprocessing_batch_id?: string | null;
  requested_by_user_id?: string | null;
  stage: 'SECURITY_VALIDATION' | 'TEXT_EXTRACTION' | 'PARSING' | 'DOCUMENT_PIPELINE_V2';
  trigger_kind?: ProcessingTriggerKind;
  user_id: string;
};

const reprocessingTriggers = new Set<ProcessingTriggerKind>([
  'USER_REPROCESS',
  'ADMIN_REPROCESS',
  'PARSER_UPGRADE',
  'AUTOMATIC_RECOVERY',
]);

function jobTrigger(job: JobRow): ProcessingTriggerKind {
  return job.trigger_kind
    ?? (job.previous_document_status ? 'USER_REPROCESS' : job.stage === 'TEXT_EXTRACTION'
      ? 'USER_TYPE_CONFIRMATION'
      : 'INITIAL_UPLOAD');
}

function isReprocessingJob(job: JobRow): boolean {
  return reprocessingTriggers.has(jobTrigger(job));
}

type DocumentRow = {
  deleted_at: Date | null;
  employment_id: string | null;
  id: string;
  import_batch_id: string;
  import_batch_item_id: string;
  object_key: string;
  size_bytes: string;
  user_id: string;
};

type ProcessResult = { stdout: string };
type QueueConsumer = {
  brPop: (key: string, timeout: number) => Promise<{ element: string } | null>;
};
type QueuePublisher = {
  lPush: (key: string, element: string) => Promise<number>;
};
type QueueWorkerClient = QueueConsumer & {
  readonly isOpen: boolean;
  destroy: () => void;
};

export class WorkerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable: boolean) {
    super(code);
    this.code = code;
    this.retryable = retryable;
    this.name = 'WorkerError';
  }
}

const securityRejectionErrorCodes = new Set([
  'DOCUMENT_ACTIVE_CONTENT',
  'DOCUMENT_CORRUPTED',
  'DOCUMENT_EMBEDDED_FILE',
  'DOCUMENT_ENCRYPTED',
  'DOCUMENT_INVALID_TYPE',
  'DOCUMENT_RENDER_LIMIT',
  'DOCUMENT_SIZE_MISMATCH',
  'DOCUMENT_TOO_LARGE',
  'DOCUMENT_TOO_MANY_PAGES',
]);

const log = (event: string, data: Record<string, string | number> = {}) => {
  process.stdout.write(`${JSON.stringify({ event, ...data, at: new Date().toISOString() })}\n`);
};

function env(name: string, localDefault?: string, aliases: string[] = []): string {
  for (const key of [name, ...aliases]) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  if (runtimeEnvironment() !== 'production' && localDefault !== undefined) return localDefault;
  throw new Error(`Missing required environment variable: ${name}`);
}

function positiveInt(name: string, localDefault: number, min: number, max: number): number {
  const raw = env(name, String(localDefault));
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid environment variable: ${name}`);
  return value;
}

function probability(name: string, localDefault: number): number {
  const value = Number(env(name, String(localDefault)));
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid environment variable: ${name}`);
  return value;
}

function loadConfig(): WorkerConfig {
  const appEnv = runtimeEnvironment();
  const storageProvider = objectStorageProvider(process.env.OBJECT_STORAGE_PROVIDER, appEnv === 'production');
  const localStorageAliases = appEnv === 'production' ? [] : ['MINIO_ROOT_USER'];
  const localStorageSecretAliases = appEnv === 'production' ? [] : ['MINIO_ROOT_PASSWORD'];
  const low = probability('CLASSIFICATION_LOW_THRESHOLD', 0.2);
  const high = probability('CLASSIFICATION_HIGH_THRESHOLD', 0.55);
  if (low >= high) throw new Error('CLASSIFICATION_LOW_THRESHOLD must be lower than CLASSIFICATION_HIGH_THRESHOLD');
  const config = {
    appEnv,
    clamavHost: env('CLAMAV_HOST', '127.0.0.1'),
    clamavPort: positiveInt('CLAMAV_PORT', 3310, 1, 65_535),
    classificationHighThreshold: high,
    classificationLowThreshold: low,
    cloudflareAccountId: storageProvider === 'r2' && appEnv === 'production' ? env('CLOUDFLARE_ACCOUNT_ID') : (process.env.CLOUDFLARE_ACCOUNT_ID?.trim() || null),
    cloudflareApiToken: storageProvider === 'r2' && appEnv === 'production' ? env('CLOUDFLARE_R2_API_TOKEN') : (process.env.CLOUDFLARE_R2_API_TOKEN?.trim() || null),
    dispatcherBatchSize: positiveInt('OUTBOX_BATCH_SIZE', 25, 1, 100),
    dispatcherPollMs: positiveInt('OUTBOX_POLL_INTERVAL_MS', 1_000, 100, 60_000),
    jobLeaseMs: positiveInt('JOB_TIMEOUT_MS', 600_000, 30_000, 3_600_000),
    maxFileBytes: positiveInt('MAX_FILE_BYTES', 20 * 1024 * 1024, 1_024, 100 * 1024 * 1024),
    maxOcrPages: positiveInt('MAX_OCR_PAGES', 10, 1, 100),
    maxOcrTimeMs: positiveInt('MAX_OCR_TIME_MS', 180_000, 1_000, 900_000),
    maxPages: positiveInt('MAX_PAGES', 50, 1, 500),
    maxParseTimeMs: positiveInt('MAX_PARSE_TIME_MS', 30_000, 1_000, 300_000),
    maxRenderPixels: positiveInt('MAX_RENDER_PIXELS', 40_000_000, 1_000_000, 200_000_000),
    maxTextBytes: positiveInt('MAX_EXTRACTED_TEXT_BYTES', 2 * 1024 * 1024, 8_192, 10 * 1024 * 1024),
    publishedRetryMs: positiveInt('PUBLISHED_RETRY_MS', 60_000, 5_000, 600_000),
    publicOrigin: storageProvider === 'r2' && appEnv === 'production' ? env('PUBLIC_ORIGIN') : (process.env.PUBLIC_ORIGIN?.trim() || null),
    queueUrl: env('QUEUE_URL', `redis://127.0.0.1:${process.env.REDIS_PORT?.trim() || '6379'}`),
    storageAccessKey: env('OBJECT_STORAGE_ACCESS_KEY', 'salarivo', localStorageAliases),
    storageBucket: env('OBJECT_STORAGE_BUCKET', 'salarivo-documents-local'),
    storageDeleteVerifyDelayMs: positiveInt('STORAGE_DELETE_VERIFY_DELAY_MS', 35_000, 100, 300_000),
    storageEndpoint: env('OBJECT_STORAGE_ENDPOINT', `http://127.0.0.1:${process.env.MINIO_API_PORT?.trim() || '9000'}`),
    storageKmsKeyId: storageProvider === 'aws' && appEnv === 'production' ? env('OBJECT_STORAGE_KMS_KEY_ID') : (process.env.OBJECT_STORAGE_KMS_KEY_ID?.trim() || null),
    storageProvider,
    storageRegion: env('OBJECT_STORAGE_REGION', 'us-east-1'),
    storageSecretKey: env('OBJECT_STORAGE_SECRET_KEY', 'salarivo_local_change_me_123', localStorageSecretAliases),
    uploadCleanupGraceMs: positiveInt('UPLOAD_CLEANUP_GRACE_MS', 15 * 60_000, 60_000, 86_400_000),
    uploadTtlMs: positiveInt('UPLOAD_TTL_SECONDS', 300, 60, 900) * 1_000,
    workerConcurrency: positiveInt('WORKER_CONCURRENCY', 2, 1, 16),
    workerConcurrencyPerUser: positiveInt('WORKER_CONCURRENCY_PER_USER', 1, 1, 8),
  };
  if (config.workerConcurrencyPerUser > config.workerConcurrency) {
    throw new Error('WORKER_CONCURRENCY_PER_USER cannot exceed WORKER_CONCURRENCY');
  }
  if (appEnv === 'production' && config.storageDeleteVerifyDelayMs <= STORAGE_REQUEST_TIMEOUT_MS) {
    throw new Error('STORAGE_DELETE_VERIFY_DELAY_MS must exceed the storage request timeout in production');
  }
  if (config.jobLeaseMs <= config.maxOcrTimeMs * 2 + config.maxParseTimeMs * 6) {
    throw new Error('JOB_TIMEOUT_MS must cover OCR and parser timeouts');
  }
  if (appEnv === 'production') {
    if (new URL(config.queueUrl).protocol !== 'rediss:') throw new Error('QUEUE_URL must use TLS in production');
    if (new URL(config.storageEndpoint).protocol !== 'https:') throw new Error('OBJECT_STORAGE_ENDPOINT must use HTTPS in production');
  }
  assertProductionStorageConfig(config);
  return config;
}

function deleteStorageObject(s3: S3Client, bucket: string, key: string) {
  return s3.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: key }),
    { abortSignal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS) },
  );
}

async function storageObjectExists(s3: S3Client, bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key }),
      { abortSignal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS) },
    );
    return true;
  } catch (error) {
    const storageError = error as { $metadata?: { httpStatusCode?: number }; name?: string };
    if (storageError.$metadata?.httpStatusCode === 404
      || storageError.name === 'NotFound'
      || storageError.name === 'NoSuchKey') return false;
    throw error;
  }
}

async function runProcess(
  command: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes: number,
  failureCode: string,
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: tmpdir(),
      env: {
        LANG: 'C.UTF-8',
        PATH: process.env.PATH ?? '',
        ...(process.env.SYSTEMROOT ? { SYSTEMROOT: process.env.SYSTEMROOT } : {}),
        ...(process.env.TESSDATA_PREFIX ? { TESSDATA_PREFIX: process.env.TESSDATA_PREFIX } : {}),
        ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      },
      shell: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: WorkerError, stdout?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: stdout ?? '' });
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new WorkerError('PROCESSING_TIMEOUT', true));
    }, timeoutMs);
    child.stdout.on('data', (raw: Buffer) => {
      outputBytes += raw.length;
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGKILL');
        finish(new WorkerError('DOCUMENT_OUTPUT_LIMIT', false));
        return;
      }
      chunks.push(raw);
    });
    child.once('error', () => finish(new WorkerError('PROCESS_TOOL_UNAVAILABLE', true)));
    child.once('close', (code) => {
      if (code !== 0) finish(new WorkerError(failureCode, failureCode.includes('OCR') || failureCode.includes('UNAVAILABLE')));
      else finish(undefined, Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function downloadObject(
  s3: S3Client,
  config: WorkerConfig,
  document: DocumentRow,
  targetPath: string,
): Promise<string> {
  const expectedSize = Number(document.size_bytes);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > config.maxFileBytes) {
    throw new WorkerError('DOCUMENT_TOO_LARGE', false);
  }
  let response;
  try {
    response = await s3.send(
      new GetObjectCommand({ Bucket: config.storageBucket, Key: document.object_key }),
      { abortSignal: AbortSignal.timeout(config.maxParseTimeMs) },
    );
  } catch {
    throw new WorkerError('STORAGE_TEMPORARILY_UNAVAILABLE', true);
  }
  if (!response.Body) throw new WorkerError('STORAGE_TEMPORARILY_UNAVAILABLE', true);
  const body = response.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
  if (response.ContentLength !== undefined && response.ContentLength !== expectedSize) {
    body.destroy?.();
    throw new WorkerError('DOCUMENT_SIZE_MISMATCH', false);
  }

  const hash = createHash('sha256');
  const file = await open(targetPath, 'wx', 0o600);
  let bytes = 0;
  let header = Buffer.alloc(0);
  try {
    for await (const raw of body) {
      const chunk = Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > config.maxFileBytes || bytes > expectedSize) throw new WorkerError('DOCUMENT_TOO_LARGE', false);
      if (header.length < 1_024) header = Buffer.concat([header, chunk.subarray(0, 1_024 - header.length)]);
      hash.update(chunk);
      await file.write(chunk);
    }
  } catch (error) {
    body.destroy?.();
    if (error instanceof WorkerError) throw error;
    throw new WorkerError('STORAGE_TEMPORARILY_UNAVAILABLE', true);
  } finally {
    await file.close();
  }
  if (bytes !== expectedSize) throw new WorkerError('DOCUMENT_SIZE_MISMATCH', false);
  if (!hasPdfMagic(header)) throw new WorkerError('DOCUMENT_INVALID_TYPE', false);
  return hash.digest('hex');
}

async function scanWithClamAv(path: string, config: WorkerConfig): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: config.clamavHost, port: config.clamavPort });
    const response: Buffer[] = [];
    let responseBytes = 0;
    let settled = false;
    const finish = (error?: WorkerError) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(Math.min(config.maxParseTimeMs, 120_000));
    socket.on('timeout', () => finish(new WorkerError('MALWARE_SCANNER_UNAVAILABLE', true)));
    socket.on('error', () => finish(new WorkerError('MALWARE_SCANNER_UNAVAILABLE', true)));
    socket.on('data', (chunk: Buffer) => {
      responseBytes += chunk.length;
      if (responseBytes > 4_096) {
        finish(new WorkerError('MALWARE_SCANNER_INVALID_RESPONSE', true));
        return;
      }
      response.push(chunk);
      const result = Buffer.concat(response).toString('utf8');
      if (!/[\0\n]/.test(result)) return;
      if (/\bOK\b/.test(result)) finish();
      else if (/\bFOUND\b/.test(result)) finish(new WorkerError('DOCUMENT_MALWARE_DETECTED', false));
      else finish(new WorkerError('MALWARE_SCANNER_INVALID_RESPONSE', true));
    });
    socket.on('connect', () => {
      void (async () => {
        if (!socket.write('zINSTREAM\0')) await once(socket, 'drain');
        for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
          const size = Buffer.allocUnsafe(4);
          size.writeUInt32BE(chunk.length);
          if (!socket.write(size)) await once(socket, 'drain');
          if (!socket.write(chunk)) await once(socket, 'drain');
        }
        socket.write(Buffer.alloc(4));
      })().catch(() => finish(new WorkerError('MALWARE_SCANNER_UNAVAILABLE', true)));
    });
  });
}

async function inspectPdf(path: string, config: WorkerConfig): Promise<number> {
  const info = await runProcess('pdfinfo', ['-box', path], config.maxParseTimeMs, 256 * 1024, 'DOCUMENT_CORRUPTED');
  const validation = validatePdfInfo(info.stdout, config.maxPages);
  if (validation.errorCode) throw new WorkerError(validation.errorCode, false);
  if (!validateRenderPixels(info.stdout, 144, config.maxRenderPixels)) {
    throw new WorkerError('DOCUMENT_RENDER_LIMIT', false);
  }
  return validation.pages ?? 0;
}

async function inspectActiveContent(path: string, config: WorkerConfig): Promise<void> {
  const javascript = await runProcess('pdfinfo', ['-js', path], config.maxParseTimeMs, 128 * 1024, 'DOCUMENT_CORRUPTED');
  if (javascript.stdout.trim()) throw new WorkerError('DOCUMENT_ACTIVE_CONTENT', false);
  const attachments = await runProcess('pdfdetach', ['-list', path], config.maxParseTimeMs, 128 * 1024, 'DOCUMENT_CORRUPTED');
  if (!/^0\s+embedded files?\s*$/im.test(attachments.stdout.trim())) {
    throw new WorkerError('DOCUMENT_EMBEDDED_FILE', false);
  }
}

type TextExtraction = { evidence: TextEvidencePage[]; text: string };
type StoredTextArtifact = TextExtraction & {
  partialOcr: boolean;
  source: Exclude<FieldSource, 'RULE'>;
  version: 1;
};
type ProcessingArtifactRow = {
  artifact_type: 'PDF_TEXT' | 'OCR_TEXT' | 'OCR_LAYOUT';
  content_sha256: string;
  extraction_run_id: string;
  object_key: string;
  page_count: number | null;
  size_bytes: string;
};
const evidenceOutputLimit = (config: WorkerConfig) => Math.min(16 * 1024 * 1024, config.maxTextBytes * 4);

function finiteArtifactNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseStoredTextArtifact(value: unknown, config: WorkerConfig): StoredTextArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
  }
  const artifact = value as Partial<StoredTextArtifact>;
  if (
    artifact.version !== 1
    || (artifact.source !== 'PDF_TEXT' && artifact.source !== 'OCR')
    || typeof artifact.partialOcr !== 'boolean'
    || typeof artifact.text !== 'string'
    || Buffer.byteLength(artifact.text) > config.maxTextBytes
    || !Array.isArray(artifact.evidence)
  ) throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
  for (const page of artifact.evidence) {
    if (
      typeof page !== 'object' || page === null || Array.isArray(page)
      || !finiteArtifactNumber(page.pageNumber) || page.pageNumber < 1
      || !finiteArtifactNumber(page.height) || page.height <= 0
      || !finiteArtifactNumber(page.width) || page.width <= 0
      || !finiteArtifactNumber(page.left) || !finiteArtifactNumber(page.top)
      || !Array.isArray(page.words)
    ) throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
    for (const word of page.words) {
      if (
        typeof word !== 'object' || word === null || Array.isArray(word)
        || typeof word.text !== 'string' || typeof word.lineKey !== 'string'
        || !finiteArtifactNumber(word.height) || !finiteArtifactNumber(word.width)
        || !finiteArtifactNumber(word.left) || !finiteArtifactNumber(word.top)
      ) throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
    }
  }
  return artifact as StoredTextArtifact;
}

async function readArtifactBytes(
  s3: S3Client,
  config: WorkerConfig,
  artifact: ProcessingArtifactRow,
): Promise<Buffer> {
  const expectedSize = Number(artifact.size_bytes);
  const maxArtifactBytes = Math.min(32 * 1024 * 1024, evidenceOutputLimit(config) * 2);
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maxArtifactBytes) {
    throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
  }
  let response;
  try {
    response = await s3.send(
      new GetObjectCommand({ Bucket: config.storageBucket, Key: artifact.object_key }),
      { abortSignal: AbortSignal.timeout(config.maxParseTimeMs) },
    );
  } catch (error) {
    const code = (error as { name?: unknown })?.name;
    if (code === 'NoSuchKey' || code === 'NotFound') {
      throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
    }
    throw new WorkerError('STORAGE_TEMPORARILY_UNAVAILABLE', true);
  }
  if (!response.Body || response.ContentLength !== undefined && response.ContentLength !== expectedSize) {
    throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
  }
  const body = response.Body as AsyncIterable<Uint8Array> & { destroy?: () => void };
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const raw of body) {
      const chunk = Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > expectedSize || bytes > maxArtifactBytes) {
        throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    body.destroy?.();
    if (error instanceof WorkerError) throw error;
    throw new WorkerError('STORAGE_TEMPORARILY_UNAVAILABLE', true);
  }
  const compressed = Buffer.concat(chunks);
  if (bytes !== expectedSize
    || createHash('sha256').update(compressed).digest('hex') !== artifact.content_sha256) {
    throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
  }
  return compressed;
}

async function loadCompatibleTextArtifact(
  s3: S3Client,
  config: WorkerConfig,
  job: JobRow,
): Promise<StoredTextArtifact | null> {
  const artifact = await pool.query<ProcessingArtifactRow>(
    `SELECT artifact.artifact_type, artifact.content_sha256, artifact.extraction_run_id,
            artifact.object_key, artifact.page_count, artifact.size_bytes
       FROM processing_artifacts AS artifact
       JOIN documents AS document
         ON document.id = artifact.document_id AND document.user_id = artifact.user_id
      WHERE artifact.user_id = $1 AND artifact.document_id = $2
        AND artifact.extraction_run_id = COALESCE($3::uuid, document.active_extraction_run_id)
        AND artifact.artifact_type IN ('PDF_TEXT', 'OCR_TEXT', 'OCR_LAYOUT')
        AND artifact.producer_name IN ('salarivo-pdf-text', 'salarivo-ocr-text')
        AND artifact.producer_version = $4
        AND artifact.metadata_no_sensitive @> '{"complete":true,"payloadVersion":1}'::jsonb
      ORDER BY CASE artifact.artifact_type WHEN 'OCR_LAYOUT' THEN 0 WHEN 'OCR_TEXT' THEN 1 ELSE 2 END,
               artifact.created_at DESC
      LIMIT 1`,
    [job.user_id, job.document_id, job.base_extraction_run_id ?? null,
      processingPipelineVersions.extractor],
  );
  const row = artifact.rows[0];
  if (!row) return null;
  const compressed = await readArtifactBytes(s3, config, row);
  let raw: Buffer;
  try {
    raw = await gunzipAsync(compressed, {
      maxOutputLength: evidenceOutputLimit(config) + config.maxTextBytes,
    });
  } catch {
    throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
  }
  if (raw.length > evidenceOutputLimit(config) + config.maxTextBytes) {
    throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
  }
  try {
    const parsed = parseStoredTextArtifact(JSON.parse(raw.toString('utf8')), config);
    if (parsed.partialOcr) throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
    return parsed;
  } catch (error) {
    if (error instanceof WorkerError) throw error;
    throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
  }
}

async function persistTextArtifact(
  s3: S3Client,
  config: WorkerConfig,
  job: JobRow,
  runId: string,
  extraction: TextExtraction,
  source: Exclude<FieldSource, 'RULE'>,
  partialOcr: boolean,
  pages: number,
): Promise<void> {
  const artifactType = source === 'OCR' ? 'OCR_LAYOUT' : 'PDF_TEXT';
  const producerName = source === 'OCR' ? 'salarivo-ocr-text' : 'salarivo-pdf-text';
  const producerVersion = processingPipelineVersions.extractor;
  const ocrLanguage = source === 'OCR' ? 'spa' : null;
  const ownsJob = async () => (await pool.query(
    `SELECT 1 FROM processing_jobs
      WHERE id = $1 AND user_id = $2 AND document_id = $3
        AND state = 'RUNNING' AND lease_owner = $4 AND execution_owner = $4`,
    [job.id, job.user_id, job.document_id, job.lease_owner],
  )).rowCount === 1;
  if (!await ownsJob()) throw new WorkerError('JOB_LEASE_LOST', false);
  const payload: StoredTextArtifact = {
    evidence: extraction.evidence,
    partialOcr,
    source,
    text: extraction.text,
    version: 1,
  };
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(payload)), { level: 9 });
  const contentSha256 = createHash('sha256').update(compressed).digest('hex');
  const objectKey = `artifacts/${createHash('sha256').update(
    `${job.user_id}:${job.document_id}:${runId}:${artifactType}:${producerName}:${producerVersion}:${ocrLanguage ?? ''}`,
  ).digest('hex')}.json.gz`;
  await pool.query(
    `INSERT INTO processing_artifacts (
       id, user_id, document_id, extraction_run_id, artifact_type, object_key,
       content_sha256, size_bytes, page_count, producer_name, producer_version,
       ocr_language, metadata_no_sensitive
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       '{"complete":false,"payloadVersion":1,"writeState":"PENDING"}'::jsonb)
     ON CONFLICT (extraction_run_id, artifact_type, producer_name, producer_version, ocr_language)
       DO NOTHING`,
    [randomUUID(), job.user_id, job.document_id, runId, artifactType, objectKey,
      contentSha256, compressed.length, pages, producerName, producerVersion, ocrLanguage],
  );
  const pendingArtifact = await pool.query<{
    content_sha256: string;
    id: string;
    object_key: string;
    write_state: string | null;
  }>(
    `SELECT id, object_key, content_sha256,
            metadata_no_sensitive ->> 'writeState' AS write_state
       FROM processing_artifacts
      WHERE user_id = $1 AND document_id = $2 AND extraction_run_id = $3
        AND artifact_type = $4 AND producer_name = $5 AND producer_version = $6
        AND ocr_language IS NOT DISTINCT FROM $7`,
    [job.user_id, job.document_id, runId, artifactType, producerName, producerVersion, ocrLanguage],
  );
  const artifact = pendingArtifact.rows[0];
  if (!artifact || artifact.object_key !== objectKey || artifact.content_sha256 !== contentSha256) {
    throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
  }
  if (artifact.write_state === 'COMPLETED') return;
  if (!await ownsJob()) throw new WorkerError('JOB_LEASE_LOST', false);
  try {
    await s3.send(new PutObjectCommand({
      Bucket: config.storageBucket,
      Key: objectKey,
      Body: compressed,
      ContentEncoding: 'gzip',
      ContentLength: compressed.length,
      ContentType: 'application/json',
      ...(config.storageKmsKeyId ? {
        ServerSideEncryption: 'aws:kms' as const,
        SSEKMSKeyId: config.storageKmsKeyId,
      } : {}),
    }), { abortSignal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS) });
  } catch {
    throw new WorkerError('STORAGE_TEMPORARILY_UNAVAILABLE', true);
  }
  if (!await ownsJob()) {
    await deleteStorageObject(s3, config.storageBucket, objectKey).catch(() => undefined);
    throw new WorkerError('JOB_LEASE_LOST', false);
  }
  const completed = await pool.query(
    `UPDATE processing_artifacts
        SET metadata_no_sensitive = jsonb_build_object(
              'complete', $3::boolean,
              'payloadVersion', 1,
              'writeState', 'COMPLETED'
            )
      WHERE id = $1 AND content_sha256 = $2
        AND metadata_no_sensitive @> '{"complete":false,"writeState":"PENDING"}'::jsonb`,
    [artifact.id, contentSha256, !partialOcr],
  );
  if (!completed.rowCount) throw new WorkerError('ARTIFACT_INTEGRITY_FAILED', false);
}

async function extractPdfText(path: string, pages: number, config: WorkerConfig): Promise<TextExtraction> {
  const [layout, evidence] = await Promise.all([
    runProcess(
      'pdftotext',
      ['-f', '1', '-l', String(pages), '-cropbox', '-layout', '-enc', 'UTF-8', path, '-'],
      config.maxParseTimeMs,
      config.maxTextBytes,
      'DOCUMENT_CORRUPTED',
    ),
    runProcess(
      'pdftotext',
      ['-f', '1', '-l', String(pages), '-cropbox', '-tsv', '-enc', 'UTF-8', path, '-'],
      config.maxParseTimeMs,
      evidenceOutputLimit(config),
      'DOCUMENT_CORRUPTED',
    ).then((result) => parseTextEvidenceTsv(result.stdout)).catch((): TextEvidencePage[] => []),
  ]);
  return {
    evidence,
    text: layout.stdout.replaceAll('\0', '').trim(),
  };
}

async function extractOcrText(
  path: string,
  pages: number,
  directory: string,
  config: WorkerConfig,
): Promise<TextExtraction & { partial: boolean }> {
  const selectedPages = Math.min(pages, config.maxOcrPages);
  // ponytail: OCR is capped per document; paginate/resume when supported scanned receipts exceed this measured ceiling.
  const deadline = Date.now() + config.maxOcrTimeMs;
  const evidence: TextEvidencePage[] = [];
  const output: string[] = [];
  const maxEvidenceBytes = evidenceOutputLimit(config);
  let evidenceBytes = 0;
  let evidenceEnabled = true;
  let textBytes = 0;
  for (let page = 1; page <= selectedPages; page += 1) {
    const remaining = () => {
      const value = deadline - Date.now();
      if (value < 1_000) throw new WorkerError('PROCESSING_TIMEOUT', true);
      return value;
    };
    const prefix = join(directory, `ocr-${randomUUID()}`);
    const imagePath = `${prefix}.png`;
    await runProcess(
      'pdftoppm',
      ['-f', String(page), '-l', String(page), '-singlefile', '-cropbox', '-r', '144', '-png', path, prefix],
      remaining(),
      64 * 1024,
      'OCR_TEMPORARILY_UNAVAILABLE',
    );
    let pageEvidence: TextEvidencePage[] = [];
    if (evidenceEnabled) {
      try {
        const result = await runProcess(
          'tesseract',
          [imagePath, 'stdout', '-l', 'spa', '--psm', '6', 'tsv'],
          remaining(),
          maxEvidenceBytes,
          'OCR_TEMPORARILY_UNAVAILABLE',
        );
        evidenceBytes += Buffer.byteLength(result.stdout);
        if (evidenceBytes <= maxEvidenceBytes) pageEvidence = parseTextEvidenceTsv(result.stdout, page);
        else evidenceEnabled = false;
      } catch {
        evidenceEnabled = false;
        pageEvidence = [];
      }
    }
    let pageText = pageEvidence.some(({ words }) => words.length)
      ? textFromEvidencePages(pageEvidence)
      : '';
    if (!pageText.trim()) {
      pageEvidence = [];
      const plain = await runProcess(
        'tesseract',
        [imagePath, 'stdout', '-l', 'spa', '--psm', '6'],
        remaining(),
        config.maxTextBytes,
        'OCR_TEMPORARILY_UNAVAILABLE',
      );
      pageText = plain.stdout;
    }
    pageText = pageText.replaceAll('\0', '').trim();
    textBytes += Buffer.byteLength(pageText);
    if (textBytes > config.maxTextBytes) throw new WorkerError('DOCUMENT_OUTPUT_LIMIT', false);
    evidence.push(...pageEvidence);
    output.push(pageText);
    await rm(imagePath, { force: true });
  }
  return { evidence, partial: selectedPages < pages, text: output.filter(Boolean).join('\n') };
}

async function completeTerminalBatches(db: PoolClient): Promise<number> {
  const completed = await db.query(
    `UPDATE import_batches AS batch
        SET status = 'COMPLETED', completed_at = now(), updated_at = now()
      WHERE batch.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM import_batch_items AS item
           WHERE item.user_id = batch.user_id AND item.batch_id = batch.id
             AND item.status IN ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING')
        )`,
  );
  return completed.rowCount ?? 0;
}

type RestorableJob = Pick<JobRow,
  'document_id' | 'previous_document_status' | 'reprocessing_batch_id' | 'trigger_kind' | 'user_id'>;

async function persistPermanentFailureState(
  db: PoolClient,
  job: RestorableJob,
  errorCode: string,
  failureSecurityStatus: 'ERROR' | 'REJECTED' = 'REJECTED',
): Promise<boolean> {
  if (isReprocessingJob(job as JobRow)) return true;
  const securityRejected = securityRejectionErrorCodes.has(errorCode);
  if (job.previous_document_status && !securityRejected) {
    await db.query(
      `UPDATE documents
          SET security_status = 'CLEAN', processing_status = $3
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [job.document_id, job.user_id, job.previous_document_status],
    );
    await db.query(
      `UPDATE import_batch_items
          SET status = CASE $3
                WHEN 'COMPLETED' THEN 'COMPLETED'
                WHEN 'NEEDS_REVIEW' THEN 'NEEDS_REVIEW'
                WHEN 'CANCELLED' THEN 'CANCELLED'
                ELSE 'FAILED'
              END,
              error_code = CASE WHEN $3 IN ('COMPLETED', 'NEEDS_REVIEW') THEN NULL ELSE $4 END,
              updated_at = now()
        WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $1 AND user_id = $2)`,
      [job.document_id, job.user_id, job.previous_document_status, errorCode],
    );
    return true;
  }
  await db.query(
    `UPDATE documents
        SET security_status = CASE
              WHEN $4::boolean THEN 'REJECTED'
              WHEN security_status = 'CLEAN' THEN 'CLEAN'
              ELSE $3
            END,
            processing_status = 'FAILED_PERMANENT'
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [job.document_id, job.user_id, failureSecurityStatus, securityRejected],
  );
  await db.query(
    `UPDATE import_batch_items SET status = 'FAILED', error_code = $3, updated_at = now()
      WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $1 AND user_id = $2)`,
    [job.document_id, job.user_id, errorCode],
  );
  return false;
}

export async function reconcileDatabaseState(
  config: Pick<WorkerConfig, 'dispatcherBatchSize'>,
): Promise<{ batches: number; exhausted: number; recovered: number; released: number }> {
  return await withTransaction(async (db: PoolClient) => {
    const expired = await db.query<JobRow & { state: 'CANCELLED' | 'FAILED' | 'RETRYABLE' }>(
      `WITH candidates AS (
         SELECT job.id, job.attempt >= job.max_attempts AS exhausted,
                users.status = 'DELETION_PENDING' AS deleting
           FROM processing_jobs AS job
           JOIN users ON users.id = job.user_id
             AND users.status IN ('ACTIVE', 'DELETION_PENDING')
          WHERE job.state = 'RUNNING' AND job.lease_expires_at < now()
          ORDER BY job.lease_expires_at
          FOR UPDATE OF job SKIP LOCKED
          LIMIT $1
       )
       UPDATE processing_jobs AS job
          SET state = CASE
                WHEN candidates.deleting THEN 'CANCELLED'
                WHEN candidates.exhausted THEN 'FAILED'
                ELSE 'RETRYABLE'
              END,
              available_at = CASE
                WHEN candidates.deleting OR candidates.exhausted THEN job.available_at
                ELSE now()
              END,
              completed_at = CASE
                WHEN candidates.deleting OR candidates.exhausted THEN now()
                ELSE NULL
              END,
              lease_owner = NULL, lease_expires_at = NULL,
              error_code = CASE
                WHEN candidates.deleting THEN 'ACCOUNT_DELETION'
                WHEN candidates.exhausted THEN 'WORKER_LEASE_EXHAUSTED'
                ELSE 'WORKER_LEASE_EXPIRED'
              END,
              updated_at = now()
         FROM candidates
        WHERE job.id = candidates.id
        RETURNING job.id, job.user_id, job.document_id, job.processing_version, job.stage,
                  job.attempt, job.max_attempts, ''::text AS lease_owner, job.state,
                  job.previous_document_status, job.trigger_kind, job.requested_by_user_id,
                  job.base_extraction_run_id, job.reprocessing_batch_id, job.pipeline_fingerprint`,
      [config.dispatcherBatchSize],
    );
    for (const job of expired.rows) {
      const run = await db.query<{ id: string }>(
        `UPDATE extraction_runs
            SET status = $4, finished_at = now(), error_code = $5,
                promotion_outcome = 'NOT_EVALUATED', promoted_at = NULL
          WHERE user_id = $1 AND document_id = $2 AND processing_version = $3
            AND status = 'PROCESSING'
          RETURNING id`,
        [job.user_id, job.document_id, job.processing_version,
          job.state === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
          job.state === 'CANCELLED'
            ? 'ACCOUNT_DELETION'
            : job.state === 'FAILED' ? 'WORKER_LEASE_EXHAUSTED' : 'WORKER_LEASE_EXPIRED'],
      );
      if (job.state === 'FAILED' && run.rows[0]) {
        await db.query(
          `INSERT INTO extraction_run_issues (
             id, user_id, document_id, extraction_run_id, code, severity,
             recoverable, metadata_no_sensitive
           ) VALUES ($1, $2, $3, $4, 'WORKER_LEASE_EXHAUSTED', 'ERROR', false, '{}'::jsonb)
           ON CONFLICT (extraction_run_id, code, affected_field_path) DO NOTHING`,
          [randomUUID(), job.user_id, job.document_id, run.rows[0].id],
        );
        await auditFailedReprocessingRun(
          db,
          job,
          run.rows[0].id,
          'WORKER_LEASE_EXHAUSTED',
        );
      }
      await refreshReprocessingBatch(db, job);
    }
    const exhausted = expired.rows.filter((job) => job.state === 'FAILED');
    for (const job of exhausted) {
      const restored = await persistPermanentFailureState(db, job, 'WORKER_LEASE_EXHAUSTED', 'ERROR');
      if (!isReprocessingJob(job)) await completeBatchIfTerminal(db, job);
      if (!restored) await scheduleRetentionDeletion(db, job);
    }
    const batches = await completeTerminalBatches(db);
    return {
      batches,
      exhausted: exhausted.length,
      recovered: expired.rows.filter((job) => job.state === 'RETRYABLE').length,
      released: 0,
    };
  });
}

async function dispatchOnce(client: QueuePublisher, config: WorkerConfig): Promise<number> {
  const selected = await withTransaction(async (db: PoolClient) => {
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended('salarivo:document-dispatch', 0))`);
    const active = await db.query<{ count: number; user_id: string }>(
      `SELECT user_id, count(*)::integer AS count
         FROM processing_jobs
        WHERE execution_owner IS NOT NULL
           OR (state = 'PUBLISHED' AND published_at >= now() - ($1 * interval '1 millisecond'))
        GROUP BY user_id`,
      [config.publishedRetryMs],
    );
    const activeJobsByUser = new Map(active.rows.map((row) => [row.user_id, row.count]));
    const jobs = await db.query<{ id: string; user_id: string }>(
      `WITH ranked AS (
         SELECT job.id, job.user_id,
                row_number() OVER (PARTITION BY job.user_id ORDER BY job.available_at, job.created_at) AS user_rank
           FROM processing_jobs AS job
           JOIN users ON users.id = job.user_id AND users.status = 'ACTIVE'
          WHERE job.stage IN ('SECURITY_VALIDATION', 'TEXT_EXTRACTION', 'PARSING', 'DOCUMENT_PIPELINE_V2')
            AND (job.stage <> 'DOCUMENT_PIPELINE_V2' OR job.pipeline_fingerprint = $3)
            AND job.execution_owner IS NULL
            AND job.attempt < job.max_attempts
            AND (
              (job.state IN ('PENDING', 'RETRYABLE') AND job.available_at <= now())
              OR (job.state = 'PUBLISHED' AND job.published_at < now() - ($1 * interval '1 millisecond'))
            )
       )
       SELECT jobs.id, jobs.user_id
         FROM processing_jobs jobs
         JOIN ranked ON ranked.id = jobs.id
        ORDER BY ranked.user_rank, jobs.available_at, jobs.created_at
        FOR UPDATE OF jobs SKIP LOCKED
        LIMIT $2`,
      [config.publishedRetryMs, config.dispatcherBatchSize + config.workerConcurrency,
        currentPipelineFingerprint],
    );
    const jobIds = selectDispatchCandidates(
      jobs.rows.map((job) => ({ id: job.id, userId: job.user_id })),
      activeJobsByUser,
      config.workerConcurrency,
      config.workerConcurrencyPerUser,
    );
    for (const jobId of jobIds) {
      await db.query(
        `UPDATE processing_jobs
            SET state = 'PUBLISHED', published_at = now(), lease_owner = NULL,
                lease_expires_at = NULL, updated_at = now()
          WHERE id = $1`,
        [jobId],
      );
    }
    return jobIds;
  });
  for (let index = 0; index < selected.length; index += 1) {
    const jobId = selected[index]!;
    try {
      await client.lPush(QUEUE_NAME, JSON.stringify({ jobId }));
    } catch (error) {
      await pool.query(
        `UPDATE processing_jobs SET state = 'PENDING', published_at = NULL, updated_at = now()
          WHERE id = ANY($1::uuid[]) AND state = 'PUBLISHED'`,
        [selected.slice(index)],
      ).catch(() => undefined);
      throw error;
    }
  }
  return selected.length;
}

async function cleanupExpiredUploads(
  s3: S3Client,
  config: WorkerConfig,
): Promise<{ batches: number; items: number; objects: number }> {
  const expired = await pool.query<{ expires_at: Date; id: string; object_key: string }>(
    `WITH candidates AS (
       SELECT session.id
         FROM upload_sessions session
        WHERE (session.status = 'OPEN' AND session.expires_at <= now()) OR session.status = 'EXPIRED'
        ORDER BY session.expires_at
        FOR UPDATE OF session SKIP LOCKED
        LIMIT 100
     )
     UPDATE upload_sessions AS session
        SET status = 'EXPIRED'
       FROM candidates
      WHERE session.id = candidates.id AND session.status IN ('OPEN', 'EXPIRED')
      RETURNING session.id, session.object_key, session.expires_at`,
  );
  const database = await withTransaction(async (db: PoolClient) => {
    const items = await db.query(
      `WITH candidates AS (
         SELECT item.id
           FROM import_batch_items AS item
           JOIN import_batches AS batch
             ON batch.user_id = item.user_id AND batch.id = item.batch_id
          WHERE item.status = 'PENDING_UPLOAD'
            AND batch.status = 'ACTIVE'
            AND NOT EXISTS (
              SELECT 1 FROM upload_sessions AS valid
               WHERE valid.user_id = item.user_id AND valid.batch_id = item.batch_id
                 AND valid.item_id = item.id
                 AND (valid.status = 'CONFIRMED'
                   OR (valid.status = 'OPEN' AND valid.expires_at > now()))
            )
            AND (
              batch.updated_at <= $1
              OR EXISTS (
                SELECT 1 FROM upload_sessions AS ended
                 WHERE ended.user_id = item.user_id AND ended.batch_id = item.batch_id
                   AND ended.item_id = item.id
                   AND (ended.status IN ('EXPIRED', 'CANCELLED')
                     OR (ended.status = 'OPEN' AND ended.expires_at <= now()))
              )
          )
          ORDER BY item.created_at
          FOR UPDATE OF batch, item SKIP LOCKED
          LIMIT 500
       )
       UPDATE import_batch_items AS item
          SET status = 'CANCELLED', error_code = 'UPLOAD_SESSION_EXPIRED', updated_at = now()
         FROM candidates
        WHERE item.id = candidates.id AND item.status = 'PENDING_UPLOAD'`,
      [pendingUploadCutoff(Date.now(), config.uploadTtlMs, config.uploadCleanupGraceMs)],
    );
    return {
      batches: await completeTerminalBatches(db),
      items: items.rowCount ?? 0,
    };
  });
  let objects = 0;
  for (const session of expired.rows) {
    const canonicalKey = `documents/${createHash('sha256').update(session.id).digest('hex')}.pdf`;
    try {
      await Promise.all([
        deleteStorageObject(s3, config.storageBucket, session.object_key),
        deleteStorageObject(s3, config.storageBucket, canonicalKey),
      ]);
      const status = uploadCleanupStatus(
        session.expires_at.getTime(), Date.now(), config.uploadCleanupGraceMs,
        config.storageProvider === 'r2',
      );
      await pool.query(
        `UPDATE upload_sessions SET status = $2
          WHERE id = $1 AND status = 'EXPIRED'`,
        [session.id, status],
      );
      objects += 1;
    } catch {
      log('upload_cleanup_error');
    }
  }
  const confirmed = await pool.query<{ expires_at: Date; id: string; object_key: string }>(
    `SELECT id, object_key, expires_at FROM upload_sessions
      WHERE status = 'CONFIRMED' AND object_key LIKE 'incoming/%'
      ORDER BY (expires_at <= now() - ($1 * interval '1 millisecond')) DESC, expires_at
      LIMIT 100`,
    [config.uploadCleanupGraceMs],
  );
  for (const session of confirmed.rows) {
    try {
      await deleteStorageObject(s3, config.storageBucket, session.object_key);
      if (uploadCleanupStatus(
        session.expires_at.getTime(),
        Date.now(),
        config.uploadCleanupGraceMs,
        config.storageProvider === 'r2',
      ) === 'CANCELLED') {
        const canonicalKey = `documents/${createHash('sha256').update(session.id).digest('hex')}.pdf`;
        await pool.query(
          `UPDATE upload_sessions SET object_key = $2
            WHERE id = $1 AND status = 'CONFIRMED' AND object_key = $3`,
          [session.id, canonicalKey, session.object_key],
        );
      }
      objects += 1;
    } catch {
      log('upload_cleanup_error');
    }
  }
  return { batches: database.batches, items: database.items, objects };
}

async function cleanupStorageDeletionTombstone(
  s3: S3Client,
  config: WorkerConfig,
  excludedUserIds: string[],
): Promise<{ deleted: number; userId: string } | null> {
  const leaseOwner = randomUUID();
  const claimed = await pool.query<{
    attempt: number;
    artifact_object_keys: string[];
    canonical_object_key: string;
    id: string;
    incoming_object_key: string;
    object_delete_verify_after: Date | null;
    uncertain_artifact_object_keys: string[];
    user_id: string;
  }>(
    `WITH candidate AS (
       SELECT tombstone.id
         FROM storage_deletion_tombstones AS tombstone
        WHERE tombstone.upload_expires_at <= now() - ($1 * interval '1 millisecond')
          AND NOT (tombstone.user_id = ANY($2::uuid[]))
          AND (tombstone.object_delete_verify_after IS NULL
               OR tombstone.object_delete_verify_after <= now())
          AND NOT EXISTS (
            SELECT 1 FROM processing_jobs AS job
             WHERE job.user_id = tombstone.user_id AND job.execution_owner IS NOT NULL
          )
          AND ((tombstone.status = 'PENDING' AND tombstone.available_at <= now())
            OR (tombstone.status = 'RUNNING' AND tombstone.lease_expires_at <= now()))
        ORDER BY tombstone.available_at, tombstone.created_at
        FOR UPDATE OF tombstone SKIP LOCKED
        LIMIT 1
     )
     UPDATE storage_deletion_tombstones AS tombstone
        SET status = 'RUNNING', attempt = attempt + 1, lease_owner = $3,
            lease_expires_at = now() + interval '5 minutes', error_code = NULL, updated_at = now()
       FROM candidate
      WHERE tombstone.id = candidate.id
       RETURNING tombstone.id, tombstone.canonical_object_key,
                 tombstone.incoming_object_key, tombstone.artifact_object_keys,
                 tombstone.uncertain_artifact_object_keys, tombstone.attempt,
                 tombstone.object_delete_verify_after, tombstone.user_id`,
    [config.uploadCleanupGraceMs, excludedUserIds, leaseOwner],
  );
  const tombstone = claimed.rows[0];
  if (!tombstone) return null;
  try {
    const objectKeys = [...new Set([
      tombstone.canonical_object_key,
      tombstone.incoming_object_key,
      ...tombstone.artifact_object_keys,
    ])];
    for (const key of objectKeys) {
      await deleteStorageObject(s3, config.storageBucket, key);
    }
    const lateUncertainWrite = await pool.query(
      `SELECT 1 FROM processing_artifacts
        WHERE user_id = $1 AND object_key = ANY($2::text[])
          AND metadata_no_sensitive @> '{"writeState":"PENDING"}'::jsonb
        LIMIT 1`,
      [tombstone.user_id, objectKeys],
    );
    if (tombstone.uncertain_artifact_object_keys.length || lateUncertainWrite.rowCount) {
      await pool.query(
        `UPDATE storage_deletion_tombstones
            SET status = 'PENDING', available_at = now() + ($3 * interval '1 millisecond'),
                object_delete_verify_after = now() + ($3 * interval '1 millisecond'),
                lease_owner = NULL, lease_expires_at = NULL,
                error_code = 'UNCERTAIN_ARTIFACT_WRITE', updated_at = now()
          WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2`,
        [tombstone.id, leaseOwner, config.storageDeleteVerifyDelayMs],
      );
      return { deleted: 0, userId: tombstone.user_id };
    }
    if (tombstone.object_delete_verify_after === null) {
      await pool.query(
        `UPDATE storage_deletion_tombstones
            SET status = 'PENDING', available_at = now() + ($3 * interval '1 millisecond'),
                object_delete_verify_after = now() + ($3 * interval '1 millisecond'),
                lease_owner = NULL, lease_expires_at = NULL, error_code = NULL, updated_at = now()
          WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2`,
        [tombstone.id, leaseOwner, config.storageDeleteVerifyDelayMs],
      );
      return { deleted: 0, userId: tombstone.user_id };
    }
    const stillPresent = (await Promise.all(
      objectKeys.map((key) => storageObjectExists(s3, config.storageBucket, key)),
    )).some(Boolean);
    const completed = stillPresent
      ? await pool.query(
          `UPDATE storage_deletion_tombstones
              SET status = 'PENDING', available_at = now() + ($3 * interval '1 millisecond'),
                  object_delete_verify_after = now() + ($3 * interval '1 millisecond'),
                  lease_owner = NULL, lease_expires_at = NULL,
                  error_code = 'STORAGE_OBJECT_STILL_PRESENT', updated_at = now()
            WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2`,
          [tombstone.id, leaseOwner, config.storageDeleteVerifyDelayMs],
        )
      : await pool.query(
          `DELETE FROM storage_deletion_tombstones
            WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2
              AND object_delete_verify_after <= now()`,
          [tombstone.id, leaseOwner],
        );
    return { deleted: completed.rowCount ?? 0, userId: tombstone.user_id };
  } catch {
    const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(tombstone.attempt, 8)) + randomInt(0, 1_000);
    await pool.query(
      `UPDATE storage_deletion_tombstones
          SET status = 'PENDING', available_at = now() + ($3 * interval '1 millisecond'),
              lease_owner = NULL, lease_expires_at = NULL,
              error_code = 'STORAGE_UNAVAILABLE', updated_at = now()
        WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2`,
      [tombstone.id, leaseOwner, delayMs],
    );
    log('storage_deletion_retry_scheduled');
    return { deleted: 0, userId: tombstone.user_id };
  }
}

async function cleanupPendingAccounts(config: WorkerConfig): Promise<number> {
  await pool.query(
    `UPDATE privacy_operations AS export
        SET status = 'CANCELLED', completed_at = now(), updated_at = now()
       FROM users
      WHERE users.id = export.user_id AND users.status = 'DELETION_PENDING'
        AND export.operation_type = 'DATA_EXPORT' AND export.status = 'RUNNING'
        AND export.updated_at < now() - interval '15 minutes'`,
  );
  const claimed = await pool.query<{ id: string; user_id: string }>(
    `WITH candidate AS (
       SELECT operation.id
         FROM privacy_operations AS operation
         JOIN users ON users.id = operation.user_id AND users.status = 'DELETION_PENDING'
        WHERE operation.operation_type = 'ACCOUNT_DELETION'
          AND (operation.status = 'PENDING'
            OR (operation.status = 'RUNNING' AND operation.updated_at < now() - interval '5 minutes'))
          AND NOT EXISTS (
            SELECT 1 FROM upload_sessions AS session
             WHERE session.user_id = operation.user_id
               AND session.expires_at > now() - ($1 * interval '1 millisecond')
          )
          AND NOT EXISTS (
            SELECT 1 FROM storage_deletion_tombstones AS tombstone
             WHERE tombstone.user_id = operation.user_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM privacy_operations AS export
             WHERE export.user_id = operation.user_id
               AND export.operation_type = 'DATA_EXPORT' AND export.status = 'RUNNING'
          )
          AND NOT EXISTS (
            SELECT 1 FROM processing_jobs AS job
             WHERE job.user_id = operation.user_id AND job.execution_owner IS NOT NULL
          )
        ORDER BY operation.created_at
        FOR UPDATE OF operation SKIP LOCKED
        LIMIT 1
     )
     UPDATE privacy_operations AS operation
        SET status = 'RUNNING', started_at = COALESCE(started_at, now()),
            error_code = NULL, updated_at = now()
       FROM candidate
      WHERE operation.id = candidate.id
      RETURNING operation.id, operation.user_id`,
    [config.uploadCleanupGraceMs],
  );
  const operation = claimed.rows[0];
  if (!operation) return 0;
  try {
    return await withTransaction(async (db: PoolClient) => {
      const deleted = await db.query(
        `DELETE FROM users WHERE id = $1 AND status = 'DELETION_PENDING' RETURNING id`,
        [operation.user_id],
      );
      if (!deleted.rowCount) return 0;
      await db.query(
        `UPDATE account_deletion_receipts
            SET status = 'COMPLETED', completed_at = now()
          WHERE operation_id = $1 AND status = 'PENDING'`,
        [operation.id],
      );
      return 1;
    });
  } catch {
    await pool.query(
      `UPDATE privacy_operations SET status = 'PENDING', error_code = 'ACCOUNT_CLEANUP_FAILED', updated_at = now()
        WHERE id = $1 AND status = 'RUNNING'`,
      [operation.id],
    );
    log('account_cleanup_error');
    return 0;
  }
}

async function cleanupExpiredMfaEnrollments(): Promise<number> {
  const removed = await pool.query(
    `DELETE FROM mfa_factors WHERE status = 'PENDING' AND pending_expires_at <= now()`,
  );
  return removed.rowCount ?? 0;
}

async function ensureProcessingRun(db: PoolClient, job: JobRow): Promise<string> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO extraction_runs (
       id, user_id, document_id, processing_version, status,
       classifier_name, classifier_version, extractor_name, extractor_version,
       parser_version, normalizer_version, started_at, trigger_kind,
       requested_by_user_id, base_extraction_run_id, result_schema_version,
       pipeline_fingerprint, promotion_outcome
     ) VALUES ($1, $2, $3, $4, 'PROCESSING', 'heuristic-ar-payroll', $5,
       'deterministic-ar-payroll', $6, $7, $8, now(), $9, $10, $11, $12, $13,
       'NOT_EVALUATED')
     ON CONFLICT (document_id, processing_version) DO UPDATE
       SET status = 'PROCESSING', finished_at = NULL, error_code = NULL,
           classifier_version = EXCLUDED.classifier_version,
           extractor_version = EXCLUDED.extractor_version,
           parser_version = EXCLUDED.parser_version,
           normalizer_version = EXCLUDED.normalizer_version,
           trigger_kind = EXCLUDED.trigger_kind,
           requested_by_user_id = EXCLUDED.requested_by_user_id,
           base_extraction_run_id = EXCLUDED.base_extraction_run_id,
           result_schema_version = EXCLUDED.result_schema_version,
           pipeline_fingerprint = EXCLUDED.pipeline_fingerprint,
           promotion_outcome = 'NOT_EVALUATED', comparison_summary = '{}'::jsonb,
           promoted_at = NULL
       WHERE extraction_runs.status IN ('PROCESSING', 'FAILED')
     RETURNING id`,
    [randomUUID(), job.user_id, job.document_id, job.processing_version,
      processingPipelineVersions.classifier, processingPipelineVersions.extractor,
      processingPipelineVersions.parser, processingPipelineVersions.normalizer,
      jobTrigger(job), job.requested_by_user_id ?? null, job.base_extraction_run_id ?? null,
      processingPipelineVersions.resultSchema,
      job.pipeline_fingerprint ?? currentPipelineFingerprint],
  );
  if (inserted.rows[0]) {
    if (job.attempt > 1) {
      await db.query(
        `DELETE FROM extraction_run_issues issue
          USING extraction_runs run
          WHERE issue.user_id = $1 AND issue.document_id = $2
            AND issue.extraction_run_id = run.id
            AND run.id = $3 AND run.status = 'PROCESSING'`,
        [job.user_id, job.document_id, inserted.rows[0].id],
      );
    }
    return inserted.rows[0].id;
  }
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM extraction_runs
      WHERE user_id = $1 AND document_id = $2 AND processing_version = $3`,
    [job.user_id, job.document_id, job.processing_version],
  );
  if (!existing.rows[0]) throw new WorkerError('EXTRACTION_PERSISTENCE_CONFLICT', true);
  return existing.rows[0].id;
}

async function refreshReprocessingBatch(db: PoolClient, job: Pick<JobRow, 'reprocessing_batch_id' | 'user_id'>): Promise<void> {
  if (!job.reprocessing_batch_id) return;
  await db.query(
    `WITH progress AS (
       SELECT count(*)::integer AS total,
              count(*) FILTER (WHERE state = 'COMPLETED')::integer AS completed,
              count(*) FILTER (WHERE state = 'FAILED')::integer AS failed,
              count(*) FILTER (WHERE state = 'CANCELLED')::integer AS cancelled,
              count(*) FILTER (WHERE state IN ('PENDING', 'PUBLISHED', 'RUNNING', 'RETRYABLE'))::integer AS active
         FROM processing_jobs
        WHERE user_id = $1 AND reprocessing_batch_id = $2
     )
     UPDATE reprocessing_batches AS batch
        SET status = CASE
              WHEN progress.active > 0 THEN 'RUNNING'
              WHEN progress.total = 0 THEN 'CANCELLED'
              WHEN progress.cancelled = progress.total THEN 'CANCELLED'
              WHEN progress.completed = progress.total THEN 'COMPLETED'
              WHEN progress.failed = progress.total THEN 'FAILED'
              ELSE 'PARTIAL'
            END,
            completed_at = CASE WHEN progress.active = 0 THEN now() ELSE NULL END,
            updated_at = now()
       FROM progress
      WHERE batch.user_id = $1 AND batch.id = $2`,
    [job.user_id, job.reprocessing_batch_id],
  );
}

async function claimJob(jobId: string, workerId: string, config: WorkerConfig): Promise<{ document: DocumentRow; job: JobRow } | null> {
  return await withTransaction(async (db: PoolClient) => {
    const owner = await db.query<{ user_id: string }>(
      `SELECT user_id FROM processing_jobs WHERE id = $1`,
      [jobId],
    );
    if (!owner.rowCount) return null;
    const activeUser = await db.query(
      `SELECT id FROM users WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE`,
      [owner.rows[0]!.user_id],
    );
    if (!activeUser.rowCount) return null;
    const candidate = await db.query<{
      available: boolean;
      has_attempts: boolean;
      stage: string;
      state: string;
      user_id: string;
    }>(
      `SELECT user_id, state, stage, available_at <= now() AS available,
              attempt < max_attempts AS has_attempts
         FROM processing_jobs
        WHERE id = $1
        FOR UPDATE`,
      [jobId],
    );
    const pending = candidate.rows[0];
    if (
      !pending
      || pending.state !== 'PUBLISHED'
      || !['SECURITY_VALIDATION', 'TEXT_EXTRACTION', 'PARSING', 'DOCUMENT_PIPELINE_V2'].includes(pending.stage)
      || !pending.available
      || !pending.has_attempts
    ) return null;
    const userId = pending.user_id;
    await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [userId]);
    const claimed = await db.query<JobRow>(
      `UPDATE processing_jobs
          SET state = 'RUNNING', attempt = attempt + 1, lease_owner = $2,
              execution_owner = $2,
              lease_expires_at = now() + ($3 * interval '1 millisecond'),
              started_at = COALESCE(started_at, now()), error_code = NULL, updated_at = now()
        WHERE id = $1 AND stage IN ('SECURITY_VALIDATION', 'TEXT_EXTRACTION', 'PARSING', 'DOCUMENT_PIPELINE_V2')
          AND state = 'PUBLISHED'
          AND available_at <= now() AND attempt < max_attempts
          AND execution_owner IS NULL
          AND (stage <> 'DOCUMENT_PIPELINE_V2' OR pipeline_fingerprint = $5)
          AND EXISTS (SELECT 1 FROM users WHERE id = processing_jobs.user_id AND status = 'ACTIVE')
          AND (SELECT count(*) FROM processing_jobs active
                WHERE active.user_id = processing_jobs.user_id AND active.state = 'RUNNING') < $4
         RETURNING id, user_id, document_id, processing_version, stage, attempt, max_attempts,
                   lease_owner, previous_document_status, trigger_kind, requested_by_user_id,
                   base_extraction_run_id, reprocessing_batch_id, pipeline_fingerprint`,
      [jobId, workerId, config.jobLeaseMs, config.workerConcurrencyPerUser, currentPipelineFingerprint],
    );
    const job = claimed.rows[0];
    if (!job) return null;
    const documents = await db.query<DocumentRow>(
      `SELECT id, user_id, import_batch_id, import_batch_item_id, employment_id,
              object_key, size_bytes, deleted_at
         FROM documents
        WHERE id = $1 AND user_id = $2
        FOR UPDATE`,
      [job.document_id, job.user_id],
    );
    const document = documents.rows[0];
    if (!document || document.deleted_at) {
      if (document) {
        const runId = await ensureProcessingRun(db, job);
        await db.query(
          `UPDATE extraction_runs
              SET status = 'CANCELLED', finished_at = now(), error_code = 'DOCUMENT_DELETED',
                  promotion_outcome = 'NOT_EVALUATED', promoted_at = NULL
            WHERE id = $1 AND status = 'PROCESSING'`,
          [runId],
        );
      }
      await db.query(
        `UPDATE processing_jobs
            SET state = 'CANCELLED', completed_at = now(), lease_owner = NULL,
                lease_expires_at = NULL, execution_owner = NULL,
                error_code = 'DOCUMENT_DELETED', updated_at = now()
          WHERE id = $1`,
        [job.id],
      );
      await refreshReprocessingBatch(db, job);
      return null;
    }
    if (isReprocessingJob(job) && job.pipeline_fingerprint) {
      const alreadyProcessed = await db.query(
        `SELECT 1 FROM extraction_runs
          WHERE user_id = $1 AND document_id = $2 AND pipeline_fingerprint = $3
            AND processing_version <> $4
            AND status IN (
              'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'REVIEW_REQUIRED'
            )
          LIMIT 1`,
        [job.user_id, job.document_id, job.pipeline_fingerprint, job.processing_version],
      );
      if (alreadyProcessed.rowCount) {
        await db.query(
          `UPDATE processing_jobs
              SET state = 'CANCELLED', completed_at = now(), lease_owner = NULL,
                  lease_expires_at = NULL, execution_owner = NULL,
                  error_code = 'PIPELINE_ALREADY_PROCESSED', updated_at = now()
            WHERE id = $1 AND state = 'RUNNING' AND lease_owner = $2`,
          [job.id, job.lease_owner],
        );
        await refreshReprocessingBatch(db, job);
        log('job_cancelled', { errorCode: 'PIPELINE_ALREADY_PROCESSED', jobId: job.id });
        return null;
      }
    }
    await ensureProcessingRun(db, job);
    await refreshReprocessingBatch(db, job);
    if (isReprocessingJob(job)) return { document, job };
    await db.query(
      `UPDATE documents
          SET processing_status = 'SECURITY_VALIDATION',
              security_status = CASE WHEN $3 = 'SECURITY_VALIDATION' THEN 'PENDING' ELSE security_status END
        WHERE id = $1 AND user_id = $2`,
      [document.id, document.user_id, job.stage],
    );
    await db.query(
      `UPDATE import_batch_items SET status = 'PROCESSING', error_code = NULL, updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [document.import_batch_item_id, document.user_id],
    );
    return { document, job };
  });
}

export async function setDocumentStage(job: JobRow, processingStatus: string, values: Record<string, unknown> = {}): Promise<void> {
  if (isReprocessingJob(job)) {
    const active = await pool.query(
      `SELECT 1 FROM processing_jobs
        WHERE id = $1 AND user_id = $2 AND document_id = $3
          AND state = 'RUNNING' AND lease_owner = $4`,
      [job.id, job.user_id, job.document_id, job.lease_owner],
    );
    if (!active.rowCount) throw new WorkerError('JOB_LEASE_LOST', false);
    return;
  }
  const allowed = new Map([
    ['security_status', 'security_status'],
    ['detected_mime_type', 'detected_mime_type'],
    ['page_count', 'page_count'],
    ['sha256', 'sha256'],
    ['classification_status', 'classification_status'],
    ['document_type', 'document_type'],
    ['classification_confidence', 'classification_confidence'],
  ]);
  const assignments = ['processing_status = $3'];
  const parameters: unknown[] = [job.document_id, job.user_id, processingStatus];
  for (const [key, value] of Object.entries(values)) {
    if (job.previous_document_status && ['classification_status', 'document_type', 'classification_confidence'].includes(key)) continue;
    const column = allowed.get(key);
    if (!column) continue;
    parameters.push(value);
    assignments.push(`${column} = $${parameters.length}`);
  }
  parameters.push(job.id, job.lease_owner);
  try {
    const result = await pool.query(
      `UPDATE documents SET ${assignments.join(', ')}
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM processing_jobs
             WHERE id = $${parameters.length - 1} AND state = 'RUNNING' AND lease_owner = $${parameters.length}
          )`,
      parameters,
    );
    if (!result.rowCount) throw new WorkerError('JOB_LEASE_LOST', false);
  } catch (error) {
    if ((error as { code?: unknown }).code === '23505') throw new WorkerError('DOCUMENT_DUPLICATE', false);
    throw error;
  }
}

async function insertClassificationField(
  db: PoolClient,
  job: JobRow,
  runId: string,
  classification: Classification,
): Promise<void> {
  await db.query(
    `INSERT INTO extracted_fields (
       id, user_id, document_id, extraction_run_id, field_path, entity_type,
       raw_value, interpreted_value, confidence, source, extractor_version, signals
     ) VALUES ($1, $2, $3, $4, 'document.type', 'DOCUMENT', $5,
       $6::jsonb, $7, 'RULE', $8, $9::jsonb)`,
    [
      randomUUID(),
      job.user_id,
      job.document_id,
      runId,
      classification.documentType,
      JSON.stringify(classification.documentType),
      classification.confidence,
      processingPipelineVersions.classifier,
      JSON.stringify({ rules: classification.signals }),
    ],
  );
}

async function completeBatchIfTerminal(
  db: PoolClient,
  job: Pick<JobRow, 'document_id' | 'user_id'>,
): Promise<void> {
  await db.query(
    `UPDATE import_batches AS batch
        SET status = 'COMPLETED', completed_at = now(), updated_at = now()
      WHERE batch.user_id = $1
        AND batch.id = (
          SELECT import_batch_id FROM documents WHERE id = $2 AND user_id = $1
        )
        AND batch.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM import_batch_items AS item
           WHERE item.user_id = batch.user_id AND item.batch_id = batch.id
             AND item.status IN ('PENDING_UPLOAD', 'UPLOADED', 'PROCESSING')
        )`,
    [job.user_id, job.document_id],
  );
}

async function scheduleRetentionDeletion(
  db: PoolClient,
  job: Pick<JobRow, 'document_id' | 'user_id'>,
): Promise<void> {
  await db.query(
    `INSERT INTO storage_deletion_tombstones (
       id, user_id, canonical_object_key, incoming_object_key, upload_expires_at
     )
     SELECT $3, document.user_id, document.object_key, session.object_key, session.expires_at
       FROM documents AS document
       JOIN upload_sessions AS session
         ON session.id = document.upload_session_id AND session.user_id = document.user_id
      WHERE document.id = $1 AND document.user_id = $2
        AND document.deleted_at IS NULL AND document.original_deleted_at IS NULL
        AND document.retention_policy = 'DELETE_AFTER_PROCESSING'
     ON CONFLICT (canonical_object_key) DO NOTHING`,
    [job.document_id, job.user_id, randomUUID()],
  );
  await db.query(
    `UPDATE documents AS document
        SET original_deleted_at = now()
      WHERE document.id = $1 AND document.user_id = $2
        AND document.deleted_at IS NULL AND document.original_deleted_at IS NULL
        AND document.retention_policy = 'DELETE_AFTER_PROCESSING'
        AND EXISTS (
          SELECT 1 FROM storage_deletion_tombstones AS tombstone
           WHERE tombstone.canonical_object_key = document.object_key
        )`,
    [job.document_id, job.user_id],
  );
}

async function finishClassification(
  job: JobRow,
  classification: Classification,
  source: FieldSource,
  computeMs: number,
): Promise<void> {
  const processingStatus = classification.decision === 'UNSUPPORTED' ? 'REJECTED_UNSUPPORTED' : 'NEEDS_TYPE_CONFIRMATION';
  await withTransaction(async (db: PoolClient) => {
    const active = await db.query(
      `SELECT 1 FROM processing_jobs
        WHERE id = $1 AND state = 'RUNNING' AND lease_owner = $2
        FOR UPDATE`,
      [job.id, job.lease_owner],
    );
    if (!active.rowCount) return;
    const runId = await ensureProcessingRun(db, job);
    await db.query(
      `DELETE FROM extracted_fields
        WHERE user_id = $1 AND document_id = $2 AND extraction_run_id = $3`,
      [job.user_id, job.document_id, runId],
    );
    await insertClassificationField(db, job, runId, classification);
    const issueCode = classification.decision === 'UNSUPPORTED'
      ? 'DOCUMENT_UNSUPPORTED'
      : 'DOCUMENT_LOW_CONFIDENCE';
    await db.query(
      `INSERT INTO extraction_run_issues (
         id, user_id, document_id, extraction_run_id, code, severity,
         recoverable, metadata_no_sensitive
       ) VALUES ($1, $2, $3, $4, $5, 'WARNING', true, '{}'::jsonb)
       ON CONFLICT (extraction_run_id, code, affected_field_path) DO NOTHING`,
      [randomUUID(), job.user_id, job.document_id, runId, issueCode],
    );
    await db.query(
      `UPDATE extraction_runs
          SET status = 'REVIEW_REQUIRED', finished_at = now(), confidence = $4,
              compute_ms = $5, ocr_provider = $6, ocr_version = $7,
              ocr_language = $8, promotion_outcome = 'REVIEW_REQUIRED',
              comparison_summary = $9::jsonb
        WHERE id = $1 AND user_id = $2 AND document_id = $3 AND status = 'PROCESSING'`,
      [runId, job.user_id, job.document_id, classification.confidence, computeMs,
        source === 'OCR' ? 'tesseract' : null,
        null,
        source === 'OCR' ? 'spa' : null,
        JSON.stringify({ issueCodes: [issueCode], reason: 'CLASSIFICATION_NOT_SUPPORTED' })],
    );
    if (!isReprocessingJob(job)) {
      await db.query(
        `UPDATE documents
            SET classification_status = $3, document_type = $4,
                classification_confidence = $5, processing_status = $6, processed_at = now()
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
            AND security_status = 'CLEAN'`,
        [job.document_id, job.user_id, classification.decision, null, classification.confidence, processingStatus],
      );
      await db.query(
        `UPDATE import_batch_items
            SET status = $3, error_code = $4, updated_at = now()
          WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $1 AND user_id = $2)`,
        [job.document_id, job.user_id,
          classification.decision === 'UNSUPPORTED' ? 'REJECTED' : 'NEEDS_REVIEW', issueCode],
      );
      if (classification.decision === 'UNSUPPORTED') await scheduleRetentionDeletion(db, job);
    }
    await db.query(
      `UPDATE processing_jobs
          SET state = 'COMPLETED', completed_at = now(), lease_owner = NULL,
              lease_expires_at = NULL, error_code = NULL, updated_at = now()
        WHERE id = $1 AND state = 'RUNNING' AND lease_owner = $2`,
      [job.id, job.lease_owner],
    );
    if (isReprocessingJob(job)) await refreshReprocessingBatch(db, job);
    else await completeBatchIfTerminal(db, job);
  });
}

type RunIssue = {
  affectedFieldPath: string | null;
  code: string;
  recoverable: boolean;
  severity: 'INFO' | 'WARNING' | 'ERROR';
};

function extractionIssues(
  extraction: PayrollExtraction,
  partialOcr: boolean,
  employerAssociationNeedsReview: boolean,
): RunIssue[] {
  const issues = new Map<string, RunIssue>();
  const add = (issue: RunIssue) => issues.set(`${issue.code}:${issue.affectedFieldPath ?? ''}`, issue);
  for (const field of extraction.fields) {
    const code = field.signals?.missingReason;
    if (!code) continue;
    add({
      affectedFieldPath: field.fieldPath,
      code,
      recoverable: code === 'LABEL_OR_LAYOUT_NOT_RECOGNIZED',
      severity: 'WARNING',
    });
  }
  const criticalValues: Record<string, string | null> = {
    'settlement.basicAmount': extraction.basicAmount,
    'settlement.deductionsAmount': extraction.deductionsAmount,
    'settlement.grossAmount': extraction.grossAmount,
    'settlement.netAmount': extraction.netAmount,
    'settlement.payrollPeriod': extraction.payrollPeriod,
  };
  for (const fieldPath of criticalFieldsBySettlementType[extraction.settlementType]) {
    if (criticalValues[fieldPath]) continue;
    const basicWarning = fieldPath === 'settlement.basicAmount';
    add({
      affectedFieldPath: fieldPath,
      code: basicWarning ? 'BASIC_AMOUNT_MISSING' : 'CRITICAL_FIELD_MISSING',
      recoverable: true,
      severity: basicWarning ? 'WARNING' : 'ERROR',
    });
  }
  if (partialOcr) add({ affectedFieldPath: null, code: 'OCR_PARTIAL', recoverable: true, severity: 'WARNING' });
  if (employerAssociationNeedsReview) {
    add({ affectedFieldPath: 'employer.name', code: 'EMPLOYER_ASSOCIATION_REVIEW', recoverable: true, severity: 'WARNING' });
  }
  if (payrollExtractionNeedsReview(extraction)) {
    add({ affectedFieldPath: null, code: 'PAYROLL_VALIDATION_FAILED', recoverable: true, severity: 'ERROR' });
  }
  return [...issues.values()];
}

function lineItemsFingerprint(extraction: Pick<PayrollExtraction, 'lineItems'>): string | null {
  if (!extraction.lineItems.length) return null;
  return createHash('sha256').update(JSON.stringify(extraction.lineItems.map((item) => ({
    amount: item.amount,
    isRecurring: item.isRecurring,
    itemType: item.itemType,
    normalizedConceptCode: item.normalizedConceptCode,
    rawDescription: item.rawDescription,
  })))).digest('hex');
}

function snapshotFromExtraction(
  extraction: PayrollExtraction,
  employerId: string | null,
  issues: readonly RunIssue[],
): ProcessingSnapshot {
  return {
    basicAmount: extraction.basicAmount,
    currencyCode: extraction.currencyCode,
    deductionsAmount: extraction.deductionsAmount,
    employerId,
    grossAmount: extraction.grossAmount,
    issueCodes: [...new Set(issues.map(({ code }) => code))].sort(),
    lineItemsFingerprint: lineItemsFingerprint(extraction),
    netAmount: extraction.netAmount,
    nonRemunerativeAmount: extraction.nonRemunerativeAmount,
    payrollPeriod: extraction.payrollPeriod,
    remunerativeAmount: extraction.remunerativeAmount,
    settlementType: extraction.settlementType,
  };
}

async function loadProcessingSnapshot(
  db: PoolClient,
  userId: string,
  documentId: string,
  runId: string,
): Promise<ProcessingSnapshot | null> {
  const result = await db.query<{
    basic_amount: string | null;
    currency_code: string | null;
    deductions_amount: string | null;
    detected_employer_id: string | null;
    gross_amount: string | null;
    net_amount: string | null;
    non_remunerative_amount: string | null;
    payroll_period: string | null;
    remunerative_amount: string | null;
    settlement_id: string | null;
    settlement_type: ProcessingSnapshot['settlementType'];
  }>(
    `SELECT settlement.id AS settlement_id, to_char(settlement.payroll_period, 'YYYY-MM') AS payroll_period,
            settlement.settlement_type, settlement.currency_code, settlement.basic_amount::text,
            settlement.gross_amount::text, settlement.net_amount::text,
            settlement.remunerative_amount::text, settlement.non_remunerative_amount::text,
            settlement.deductions_amount::text,
            COALESCE(
              CASE WHEN document.active_extraction_run_id = run.id THEN document.detected_employer_id END,
              run.detected_employer_id
            ) AS detected_employer_id
       FROM extraction_runs AS run
       JOIN documents AS document
         ON document.id = run.document_id AND document.user_id = run.user_id
       LEFT JOIN payroll_settlements AS settlement
         ON settlement.user_id = run.user_id AND settlement.document_id = run.document_id
        AND settlement.extraction_run_id = run.id AND settlement.settlement_ordinal = 1
      WHERE run.id = $1 AND run.user_id = $2 AND run.document_id = $3`,
    [runId, userId, documentId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const [issues, lineItems] = await Promise.all([
    db.query<{ code: string }>(
      `SELECT code FROM extraction_run_issues
        WHERE user_id = $1 AND document_id = $2 AND extraction_run_id = $3
        ORDER BY code`,
      [userId, documentId, runId],
    ),
    row.settlement_id
      ? db.query<{
          amount: string;
          is_recurring: boolean | null;
          item_type: PayrollExtraction['lineItems'][number]['itemType'];
          normalized_concept_code: string | null;
          raw_description: string;
        }>(
          `SELECT amount::text, is_recurring, item_type, normalized_concept_code, raw_description
             FROM payroll_line_items
            WHERE user_id = $1 AND settlement_id = $2
            ORDER BY item_ordinal`,
          [userId, row.settlement_id],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  return {
    basicAmount: row.basic_amount,
    currencyCode: row.currency_code,
    deductionsAmount: row.deductions_amount,
    employerId: row.detected_employer_id,
    grossAmount: row.gross_amount,
    issueCodes: [...new Set(issues.rows.map(({ code }) => code))],
    lineItemsFingerprint: lineItems.rows.length
      ? createHash('sha256').update(JSON.stringify(lineItems.rows.map((item) => ({
          amount: item.amount,
          isRecurring: item.is_recurring,
          itemType: item.item_type,
          normalizedConceptCode: item.normalized_concept_code,
          rawDescription: item.raw_description,
        })))).digest('hex')
      : null,
    netAmount: row.net_amount,
    nonRemunerativeAmount: row.non_remunerative_amount,
    payrollPeriod: row.payroll_period,
    remunerativeAmount: row.remunerative_amount,
    settlementType: row.settlement_type,
  };
}

export async function persistExtraction(
  job: JobRow,
  classification: Classification,
  extraction: PayrollExtraction,
  source: FieldSource,
  partialOcr: boolean,
  computeMs: number,
): Promise<'COMPLETED' | 'NEEDS_REVIEW' | null> {
  return await withTransaction(async (db: PoolClient) => {
    await lockEmployerMutation(db);
    const activeJob = await db.query(
      `SELECT 1 FROM processing_jobs
        WHERE id = $1 AND state = 'RUNNING' AND document_id = $2 AND user_id = $3 AND lease_owner = $4
        FOR UPDATE`,
      [job.id, job.document_id, job.user_id, job.lease_owner],
    );
    if (!activeJob.rowCount) return null;
    const observedDocument = await db.query<{ employment_id: string | null }>(
      `SELECT employment_id FROM documents
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [job.document_id, job.user_id],
    );
    if (!observedDocument.rowCount) {
      await db.query(
        `UPDATE processing_jobs
            SET state = 'CANCELLED', completed_at = now(), lease_owner = NULL,
                lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [job.id, job.lease_owner],
      );
      await db.query(
        `UPDATE extraction_runs
            SET status = 'CANCELLED', finished_at = now(), error_code = 'DOCUMENT_DELETED',
                promotion_outcome = 'NOT_EVALUATED', promoted_at = NULL
          WHERE user_id = $1 AND document_id = $2 AND processing_version = $3
            AND status = 'PROCESSING'`,
        [job.user_id, job.document_id, job.processing_version],
      );
      await refreshReprocessingBatch(db, job);
      return null;
    }

    const anticipatedCorrections = await db.query<{ corrected_value: unknown; field_path: string }>(
      `SELECT DISTINCT ON (correction.field_path)
              correction.field_path, correction.corrected_value
         FROM user_corrections AS correction
         JOIN extraction_runs AS previous_run
           ON previous_run.id = correction.extraction_run_id
          AND previous_run.user_id = correction.user_id
          AND previous_run.document_id = correction.document_id
         JOIN documents AS active_document
           ON active_document.id = correction.document_id
          AND active_document.user_id = correction.user_id
        WHERE correction.user_id = $1 AND correction.document_id = $2
          AND previous_run.id = COALESCE($3::uuid, active_document.active_extraction_run_id)
        ORDER BY correction.field_path, previous_run.processing_version DESC,
                 correction.correction_version DESC, correction.created_at DESC, correction.id DESC`,
      [job.user_id, job.document_id, job.base_extraction_run_id ?? null],
    );
    const anticipatedExtraction = applySettlementCorrections(
      extraction,
      anticipatedCorrections.rows.map((correction) => ({
        correctedValue: correction.corrected_value,
        fieldPath: correction.field_path,
      })),
    );
    const observedEmploymentId = observedDocument.rows[0]?.employment_id ?? null;
    let currentCanonicalEmployerId: string | null = null;
    if (observedEmploymentId) {
      const observedEmployment = await db.query<{ employer_id: string }>(
        `SELECT employer_id FROM employments WHERE id = $1 AND user_id = $2`,
        [observedEmploymentId, job.user_id],
      );
      const observedEmployerId = observedEmployment.rows[0]?.employer_id;
      const currentEmployer = observedEmployerId
        ? await followMergedEmployer(db, observedEmployerId)
        : null;
      const lockedEmployment = await db.query<{ employer_id: string }>(
        `SELECT employer_id FROM employments
          WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [observedEmploymentId, job.user_id],
      );
      if (!lockedEmployment.rows[0]
        || !observedEmployerId
        || ![observedEmployerId, currentEmployer?.id].includes(lockedEmployment.rows[0].employer_id)) {
        throw new WorkerError('EMPLOYMENT_ASSOCIATION_CHANGED', true);
      }
      currentCanonicalEmployerId = currentEmployer?.id ?? null;
    }

    let resolvedEmployer: Awaited<ReturnType<typeof resolveEmployer>> | null = null;
    let employerResolutionError: EmployerResolutionError | null = null;
    if (anticipatedExtraction.employerName) {
      try {
        resolvedEmployer = await resolveEmployer(db, {
          name: anticipatedExtraction.employerName,
          countryCode: 'AR',
          createdByUserId: job.user_id,
          createdSource: 'DOCUMENT',
          ...(currentCanonicalEmployerId ? { preferredEmployerId: currentCanonicalEmployerId } : {}),
        });
      } catch (error) {
        if (!(error instanceof EmployerResolutionError)) throw error;
        employerResolutionError = error;
      }
    }

    let automaticEmploymentId: string | null = null;
    let automaticMatchRule: string | null = null;
    if (!observedEmploymentId && resolvedEmployer && anticipatedExtraction.payrollPeriod) {
      const candidates = await db.query<{ id: string }>(
        `SELECT employment.id
           FROM employments AS employment
           JOIN employers AS employer ON employer.id = employment.employer_id
          WHERE employment.user_id = $1
            AND employment.employer_id = $2
            AND employment.currency_code = $3
            AND date_trunc('month', employment.start_date)::date <= $4::date
            AND (employment.end_date IS NULL
              OR date_trunc('month', employment.end_date)::date >= $4::date)
            AND ($6::boolean OR normalize_employer_name_conservative(employer.name)
              = normalize_employer_name_conservative($5))
          ORDER BY employment.id
          LIMIT 2
          FOR SHARE OF employment`,
        [
          job.user_id,
          resolvedEmployer.id,
          anticipatedExtraction.currencyCode,
          `${anticipatedExtraction.payrollPeriod}-01`,
          anticipatedExtraction.employerName,
          resolvedEmployer.outcome === 'ALIAS' || resolvedEmployer.outcome === 'IDENTIFIER',
        ],
      );
      if (candidates.rowCount === 1) {
        automaticEmploymentId = candidates.rows[0]!.id;
        automaticMatchRule = resolvedEmployer.outcome === 'ALIAS'
          ? 'EXACT_ALIAS_CURRENCY_PERIOD_UNIQUE'
          : resolvedEmployer.outcome === 'IDENTIFIER'
            ? 'EXACT_IDENTIFIER_CURRENCY_PERIOD_UNIQUE'
            : 'EXACT_CONSERVATIVE_NAME_CURRENCY_PERIOD_UNIQUE';
      }
    }

    const activeDocument = await db.query<{
      active_extraction_run_id: string | null;
      employment_id: string | null;
      security_status: string;
    }>(
      `SELECT active_extraction_run_id, employment_id, security_status FROM documents
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [job.document_id, job.user_id],
    );
    if (!activeDocument.rowCount) throw new WorkerError('DOCUMENT_NOT_AVAILABLE', false);
    if (String(activeDocument.rows[0]?.employment_id) !== String(observedEmploymentId)) {
      throw new WorkerError('EMPLOYMENT_ASSOCIATION_CHANGED', true);
    }

    const runId = await ensureProcessingRun(db, job);
    const existingFields = await db.query<{ count: number }>(
      `SELECT count(*)::integer AS count FROM extracted_fields
        WHERE user_id = $1 AND document_id = $2 AND extraction_run_id = $3`,
      [job.user_id, job.document_id, runId],
    );
    const persistCandidate = (existingFields.rows[0]?.count ?? 0) === 0;

    let effectiveExtraction = anticipatedExtraction;
    let employerAssociationNeedsReview = false;
    if (persistCandidate) {
      await insertClassificationField(db, job, runId, classification);
      for (const field of extraction.fields) {
        await db.query(
          `INSERT INTO extracted_fields (
             id, user_id, document_id, extraction_run_id, field_path, entity_type,
             raw_value, interpreted_value, confidence, source, page_number, source_region,
             extractor_version, signals
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12::jsonb, $13, $14::jsonb)`,
          [
            randomUUID(),
            job.user_id,
            job.document_id,
            runId,
            field.fieldPath,
            field.fieldPath.startsWith('employer.') ? 'EMPLOYER' : 'PAYROLL_SETTLEMENT',
            field.rawValue,
            JSON.stringify(field.interpretedValue),
            field.confidence,
            field.source,
            field.pageNumber ?? null,
            field.sourceRegion ? JSON.stringify(field.sourceRegion) : null,
            processingPipelineVersions.extractor,
            JSON.stringify(field.signals ?? {}),
          ],
        );
      }

      const previousCorrections = await db.query<{
        corrected_value: unknown;
        extracted_field_id: string | null;
        extracted_value: unknown;
        field_path: string;
        inherited_root_id: string;
      }>(
        `SELECT DISTINCT ON (correction.field_path)
                correction.field_path, correction.corrected_value,
                COALESCE(correction.inherited_from_correction_id, correction.id) AS inherited_root_id,
                current_field.id AS extracted_field_id,
                current_field.interpreted_value AS extracted_value
           FROM user_corrections AS correction
           JOIN extraction_runs AS previous_run
             ON previous_run.id = correction.extraction_run_id
            AND previous_run.user_id = correction.user_id
            AND previous_run.document_id = correction.document_id
           LEFT JOIN extracted_fields AS current_field
             ON current_field.user_id = correction.user_id
            AND current_field.document_id = correction.document_id
            AND current_field.extraction_run_id = $3
            AND current_field.field_path = correction.field_path
           JOIN documents AS active_document
             ON active_document.id = correction.document_id
            AND active_document.user_id = correction.user_id
           WHERE correction.user_id = $1 AND correction.document_id = $2
             AND previous_run.id = COALESCE($4::uuid, active_document.active_extraction_run_id)
          ORDER BY correction.field_path, previous_run.processing_version DESC,
                   correction.correction_version DESC, correction.created_at DESC, correction.id DESC`,
        [job.user_id, job.document_id, runId, job.base_extraction_run_id ?? null],
      );
      for (const correction of previousCorrections.rows) {
        await db.query(
          `INSERT INTO user_corrections (
             id, user_id, extracted_field_id, document_id, extraction_run_id, field_path,
             correction_version, extracted_value, corrected_value, inherited_from_correction_id
           ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7::jsonb, $8::jsonb, $9)`,
          [
            randomUUID(),
            job.user_id,
            correction.extracted_field_id,
            job.document_id,
            runId,
            correction.field_path,
            JSON.stringify(correction.extracted_value ?? null),
            JSON.stringify(correction.corrected_value ?? null),
            correction.inherited_root_id,
          ],
        );
      }
      effectiveExtraction = applySettlementCorrections(
        extraction,
        previousCorrections.rows.map((correction) => ({
          correctedValue: correction.corrected_value,
          fieldPath: correction.field_path,
        })),
      );
      if (
        effectiveExtraction.employerName !== anticipatedExtraction.employerName
        || effectiveExtraction.payrollPeriod !== anticipatedExtraction.payrollPeriod
        || effectiveExtraction.currencyCode !== anticipatedExtraction.currencyCode
      ) {
        throw new WorkerError('CORRECTION_CHANGED_DURING_PROCESSING', true);
      }

      if (effectiveExtraction.employerName) {
        if (employerResolutionError) {
          const resolutionEvent = employerResolutionError.code === 'AMBIGUOUS'
            ? 'employer.match.ambiguous'
            : employerResolutionError.code === 'REJECTED_IDENTIFIER'
              ? 'employer.identifier.rejected'
              : 'employer.match.invalid';
          employerAssociationNeedsReview = true;
          log(resolutionEvent, {
            jobId: job.id,
            resolutionCode: employerResolutionError.code,
            source: 'DOCUMENT',
            userId: job.user_id,
          });
        }
        if (resolvedEmployer) {
          const employerEvent = resolvedEmployer.outcome === 'CREATED'
            ? 'employer.pending.created'
            : resolvedEmployer.status === 'PENDING'
              ? 'employer.pending.reused'
              : 'employer.reused';
          log(employerEvent, {
            employerId: resolvedEmployer.id,
            employerStatus: resolvedEmployer.status,
            matchType: resolvedEmployer.outcome,
            source: 'DOCUMENT',
            userId: job.user_id,
          });
          let employmentId = activeDocument.rows[0]?.employment_id ?? null;
           let existingEmployerMismatch = false;
           if (employmentId && currentCanonicalEmployerId !== resolvedEmployer.id) {
               existingEmployerMismatch = true;
               employerAssociationNeedsReview = true;
             if (!isReprocessingJob(job)) {
               await db.query(
                `UPDATE documents SET detected_employer_id = $1
                  WHERE id = $2 AND user_id = $3`,
                [resolvedEmployer.id, job.document_id, job.user_id],
              );
              await db.query(
                `INSERT INTO audit_events (
                   id, user_id, actor_user_id, action, resource_type, resource_id,
                   result, metadata_no_sensitive
                 ) VALUES ($1, $2, NULL, 'EMPLOYMENT_ASSOCIATION_MISMATCH', 'DOCUMENT', $3,
                   'SUCCESS', $4::jsonb)`,
                [
                  randomUUID(), job.user_id, job.document_id,
                  JSON.stringify({
                    detectedEmployerId: resolvedEmployer.id,
                    preservedEmploymentId: employmentId,
                    matchRule: 'EMPLOYER_CHANGED_ON_REPROCESS',
                    resolverVersion: 'employer-resolver-v2',
                    source: 'WORKER',
                  }),
                ],
              );
               log('employment.association_mismatch', {
                documentId: job.document_id,
                detectedEmployerId: resolvedEmployer.id,
                preservedEmploymentId: employmentId,
                matchRule: 'EMPLOYER_CHANGED_ON_REPROCESS',
                resolverVersion: 'employer-resolver-v2',
                source: 'WORKER',
                 userId: job.user_id,
               });
             }
           }
          if (!employmentId && !existingEmployerMismatch) {
            employmentId = automaticEmploymentId;
          }
          if (!isReprocessingJob(job)) {
            await db.query(
              `UPDATE documents
                  SET detected_employer_id = $1,
                      employment_id = COALESCE(employment_id, $2)
                WHERE id = $3 AND user_id = $4`,
              [resolvedEmployer.id, employmentId, job.document_id, job.user_id],
            );
          }
          if (!isReprocessingJob(job) && !activeDocument.rows[0]?.employment_id && employmentId) {
            await db.query(
              `UPDATE import_batch_items AS item
                  SET employment_id = $1, updated_at = now()
                FROM documents AS document
               WHERE document.id = $2 AND document.user_id = $3
                 AND item.id = document.import_batch_item_id AND item.user_id = document.user_id`,
              [employmentId, job.document_id, job.user_id],
            );
            await db.query(
              `INSERT INTO audit_events (
                 id, user_id, actor_user_id, action, resource_type, resource_id,
                 result, metadata_no_sensitive
               ) VALUES ($1, $2, NULL, 'EMPLOYMENT_AUTO_ASSOCIATED', 'DOCUMENT', $3,
                 'SUCCESS', $4::jsonb)`,
              [
                randomUUID(),
                job.user_id,
                job.document_id,
                JSON.stringify({
                  employerId: resolvedEmployer.id,
                  employmentId,
                  matchRule: automaticMatchRule,
                  resolverVersion: 'employer-resolver-v2',
                  source: 'WORKER',
                }),
              ],
            );
            log('employment.auto_associated', {
              documentId: job.document_id,
              employerId: resolvedEmployer.id,
              employmentId,
              matchRule: automaticMatchRule ?? 'UNKNOWN',
              resolverVersion: 'employer-resolver-v2',
              source: 'WORKER',
              userId: job.user_id,
            });
          }
        } else if (!isReprocessingJob(job)) {
          await db.query(
            `UPDATE documents SET detected_employer_id = NULL
              WHERE id = $1 AND user_id = $2`,
            [job.document_id, job.user_id],
          );
        }
      } else if (!isReprocessingJob(job)) {
        await db.query(
          `UPDATE documents SET detected_employer_id = NULL
            WHERE id = $1 AND user_id = $2`,
          [job.document_id, job.user_id],
        );
      }

      if (effectiveExtraction.payrollPeriod) {
        const settlement = await db.query<{ id: string }>(
          `INSERT INTO payroll_settlements (
             id, user_id, document_id, extraction_run_id, employment_id, settlement_ordinal,
             payroll_period, settlement_type, is_recurring, currency_code,
             basic_amount, gross_amount, net_amount, remunerative_amount,
             non_remunerative_amount, deductions_amount
           ) VALUES ($1, $2, $3, $4,
             (SELECT employment_id FROM documents WHERE id = $3 AND user_id = $2),
             1, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id`,
          [
            randomUUID(),
            job.user_id,
            job.document_id,
            runId,
            `${effectiveExtraction.payrollPeriod}-01`,
            effectiveExtraction.settlementType,
            effectiveExtraction.settlementType === 'NORMAL',
            effectiveExtraction.currencyCode,
            effectiveExtraction.basicAmount,
            effectiveExtraction.grossAmount,
            effectiveExtraction.netAmount,
            effectiveExtraction.remunerativeAmount,
            effectiveExtraction.nonRemunerativeAmount,
            effectiveExtraction.deductionsAmount,
          ],
        );
        const settlementId = settlement.rows[0]?.id;
        if (!settlementId) throw new WorkerError('EXTRACTION_PERSISTENCE_CONFLICT', true);
        let ordinal = 0;
        for (const item of extraction.lineItems) {
          ordinal += 1;
          await db.query(
            `INSERT INTO payroll_line_items (
               id, user_id, settlement_id, item_ordinal, raw_description,
               normalized_concept_code, amount, currency_code, item_type,
               is_recurring, confidence, source_field
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
              randomUUID(),
              job.user_id,
              settlementId,
              ordinal,
              item.rawDescription,
              item.normalizedConceptCode,
              item.amount,
              effectiveExtraction.currencyCode,
              item.itemType,
              item.isRecurring,
              item.confidence,
              item.itemType === 'DEDUCTION' ? null : item.normalizedConceptCode,
            ],
          );
        }
      }
    }

    const issues = extractionIssues(effectiveExtraction, partialOcr, employerAssociationNeedsReview);
    for (const issue of issues) {
      await db.query(
        `INSERT INTO extraction_run_issues (
           id, user_id, document_id, extraction_run_id, code, severity,
           recoverable, affected_field_path, metadata_no_sensitive
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)
         ON CONFLICT (extraction_run_id, code, affected_field_path) DO NOTHING`,
        [randomUUID(), job.user_id, job.document_id, runId, issue.code,
          issue.severity, issue.recoverable, issue.affectedFieldPath],
      );
    }
    const needsReview = partialOcr
      || employerAssociationNeedsReview
      || issues.some(({ severity }) => severity === 'ERROR');
    const runStatus = needsReview
      ? 'REVIEW_REQUIRED'
      : issues.length
        ? 'COMPLETED_WITH_WARNINGS'
        : 'COMPLETED';
    const previousRunId = activeDocument.rows[0]!.active_extraction_run_id;
    const securityBlocksPromotion = activeDocument.rows[0]!.security_status !== 'CLEAN';
    const restoresMissingBaseline = isReprocessingJob(job) && previousRunId === null;
    const candidateSnapshot = snapshotFromExtraction(
      effectiveExtraction,
      resolvedEmployer?.id ?? null,
      issues,
    );
    const previousSnapshot = previousRunId
      ? await loadProcessingSnapshot(db, job.user_id, job.document_id, previousRunId)
      : null;
    let comparison = previousSnapshot
      ? compareProcessingSnapshots(previousSnapshot, candidateSnapshot)
      : 'IMPROVED';
    if (securityBlocksPromotion
      || (needsReview && previousRunId !== null)
      || (job.base_extraction_run_id && job.base_extraction_run_id !== previousRunId)) {
      comparison = 'REVIEW_REQUIRED';
    }
    let promotionOutcome = comparison === 'UNCHANGED'
      ? 'UNCHANGED'
      : comparison === 'REGRESSED'
        ? 'REJECTED_REGRESSION'
        : comparison === 'REVIEW_REQUIRED'
          ? 'REVIEW_REQUIRED'
          : 'PROMOTED';
    let evaluationReason = previousRunId === null ? 'BASELINE_ACTIVATED' : comparison;
    await db.query(
      `UPDATE extraction_runs
          SET status = $4, finished_at = now(), confidence = $5, compute_ms = $6,
              classifier_version = $7, extractor_version = $8, parser_version = $9,
              normalizer_version = $10, result_schema_version = $11,
              pipeline_fingerprint = $12, ocr_provider = $13, ocr_version = $14,
              ocr_language = $15, detected_employer_id = $16,
              promotion_outcome = $17, comparison_summary = $18::jsonb,
              promoted_at = CASE WHEN $17 = 'PROMOTED' THEN now() ELSE NULL END,
              error_code = NULL
        WHERE id = $1 AND user_id = $2 AND document_id = $3`,
      [runId, job.user_id, job.document_id, runStatus, classification.confidence, computeMs,
        processingPipelineVersions.classifier, processingPipelineVersions.extractor,
        processingPipelineVersions.parser, processingPipelineVersions.normalizer,
        processingPipelineVersions.resultSchema,
        job.pipeline_fingerprint ?? currentPipelineFingerprint,
        source === 'OCR' ? 'tesseract' : null, null,
        source === 'OCR' ? 'spa' : null, resolvedEmployer?.id ?? null,
        promotionOutcome,
        JSON.stringify({
          comparison,
          issueCodes: candidateSnapshot.issueCodes,
          previousRunPresent: previousRunId !== null,
        })],
    );
    if (promotionOutcome === 'PROMOTED') {
      const promoted = await db.query(
        `UPDATE documents
            SET active_extraction_run_id = $3, detected_employer_id = $4,
                classification_status = 'SUPPORTED', document_type = 'PAYROLL',
                classification_confidence = $5, processing_status = $7,
                processed_at = now()
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
            AND security_status = 'CLEAN'
            AND active_extraction_run_id IS NOT DISTINCT FROM $6::uuid`,
        [job.document_id, job.user_id, runId, resolvedEmployer?.id ?? null,
          classification.confidence, previousRunId, needsReview ? 'NEEDS_REVIEW' : 'COMPLETED'],
      );
      if (!promoted.rowCount) {
        promotionOutcome = 'REVIEW_REQUIRED';
        evaluationReason = securityBlocksPromotion ? 'SECURITY_NOT_CLEAN' : 'ACTIVE_RUN_CHANGED';
        await db.query(
          `UPDATE extraction_runs
              SET promotion_outcome = 'REVIEW_REQUIRED', promoted_at = NULL,
                  comparison_summary = jsonb_build_object(
                    'comparison', 'REVIEW_REQUIRED',
                    'reason', $2::text
                  )
            WHERE id = $1`,
          [runId, evaluationReason],
        );
      }
    } else if (!isReprocessingJob(job)) {
      await db.query(
        `UPDATE documents
            SET classification_status = 'SUPPORTED', document_type = 'PAYROLL',
                classification_confidence = $3, processing_status = 'NEEDS_REVIEW', processed_at = now()
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [job.document_id, job.user_id, classification.confidence],
      );
    }
    if (isReprocessingJob(job)) {
      await db.query(
        `INSERT INTO audit_events (
           id, user_id, actor_user_id, action, resource_type, resource_id,
           result, metadata_no_sensitive
         ) VALUES ($1, $2, $3, 'EXTRACTION_RUN_EVALUATED', 'EXTRACTION_RUN', $4,
           'SUCCESS', $5::jsonb)`,
        [randomUUID(), job.user_id, job.requested_by_user_id ?? null, runId,
          JSON.stringify({
            activeRunAfterId: promotionOutcome === 'PROMOTED' ? runId : previousRunId,
            activeRunBeforeId: previousRunId,
            candidateRunId: runId,
            outcome: promotionOutcome,
            pipelineFingerprint: job.pipeline_fingerprint ?? currentPipelineFingerprint,
            processingVersion: job.processing_version,
            reason: evaluationReason,
            triggerKind: jobTrigger(job),
          })],
      );
    }
    if (!isReprocessingJob(job) || restoresMissingBaseline) {
      const itemNeedsReview = needsReview || promotionOutcome !== 'PROMOTED';
      await db.query(
        `UPDATE import_batch_items
            SET status = $3, error_code = NULL, updated_at = now()
          WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $1 AND user_id = $2)`,
        [job.document_id, job.user_id, itemNeedsReview ? 'NEEDS_REVIEW' : 'COMPLETED'],
      );
      if (!itemNeedsReview) await scheduleRetentionDeletion(db, job);
    }
    await db.query(
      `UPDATE processing_jobs
          SET state = 'COMPLETED', completed_at = now(), lease_owner = NULL,
              lease_expires_at = NULL, error_code = NULL, updated_at = now()
        WHERE id = $1 AND state = 'RUNNING' AND lease_owner = $2`,
      [job.id, job.lease_owner],
    );
    if (isReprocessingJob(job)) await refreshReprocessingBatch(db, job);
    if (!isReprocessingJob(job) || restoresMissingBaseline) await completeBatchIfTerminal(db, job);
    log('extraction_evaluated', { jobId: job.id, outcome: promotionOutcome, runId });
    return needsReview ? 'NEEDS_REVIEW' : 'COMPLETED';
  });
}

function normalizeError(error: unknown): WorkerError {
  return error instanceof WorkerError ? error : new WorkerError('WORKER_INTERNAL_ERROR', true);
}

async function auditFailedReprocessingRun(
  db: PoolClient,
  job: JobRow,
  runId: string,
  reason: string,
  activeBeforeId?: string | null,
): Promise<void> {
  if (!isReprocessingJob(job)) return;
  const active = await db.query<{ active_extraction_run_id: string | null }>(
    `SELECT active_extraction_run_id FROM documents
      WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [job.document_id, job.user_id],
  );
  const activeAfterId = active.rows[0]?.active_extraction_run_id ?? null;
  await db.query(
    `INSERT INTO audit_events (
       id, user_id, actor_user_id, action, resource_type, resource_id,
       result, metadata_no_sensitive
     ) VALUES ($1, $2, $3, 'EXTRACTION_RUN_EVALUATED', 'EXTRACTION_RUN', $4,
       'FAILED', $5::jsonb)`,
    [randomUUID(), job.user_id, job.requested_by_user_id ?? null, runId,
      JSON.stringify({
        activeRunAfterId: activeAfterId,
        activeRunBeforeId: activeBeforeId ?? job.base_extraction_run_id ?? activeAfterId,
        candidateRunId: runId,
        outcome: 'FAILED',
        pipelineFingerprint: job.pipeline_fingerprint ?? currentPipelineFingerprint,
        processingVersion: job.processing_version,
        reason,
        triggerKind: jobTrigger(job),
      })],
  );
}

export async function failJob(job: JobRow, rawError: unknown): Promise<void> {
  const error = normalizeError(rawError);
  const errorCode = /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'WORKER_INTERNAL_ERROR';
  const retryable = error.retryable && job.attempt < job.max_attempts;
  const delayMs = Math.min(300_000, 1_000 * 2 ** Math.min(job.attempt, 8)) + randomInt(0, 1_000);
  await withTransaction(async (db: PoolClient) => {
    let restoredPreviousState = false;
    const updated = await db.query(
      `UPDATE processing_jobs
          SET state = $3, available_at = CASE WHEN $3 = 'RETRYABLE'
                THEN now() + ($4 * interval '1 millisecond') ELSE available_at END,
              completed_at = CASE WHEN $3 = 'FAILED' THEN now() ELSE completed_at END,
              lease_owner = NULL, lease_expires_at = NULL, error_code = $5, updated_at = now()
        WHERE id = $1 AND user_id = $2 AND state = 'RUNNING' AND lease_owner = $6`,
      [job.id, job.user_id, retryable ? 'RETRYABLE' : 'FAILED', delayMs, errorCode, job.lease_owner],
    );
    if (!updated.rowCount) return;
    const activeBefore = isReprocessingJob(job) && !retryable
      ? await db.query<{ active_extraction_run_id: string | null }>(
          `SELECT active_extraction_run_id FROM documents
            WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [job.document_id, job.user_id],
        )
      : null;
    const runId = await ensureProcessingRun(db, job);
    await db.query(
      `UPDATE extraction_runs
          SET status = 'FAILED', finished_at = now(), error_code = $4,
              promotion_outcome = 'NOT_EVALUATED', promoted_at = NULL,
              comparison_summary = $5::jsonb
        WHERE id = $1 AND user_id = $2 AND document_id = $3 AND status = 'PROCESSING'`,
      [runId, job.user_id, job.document_id, errorCode,
        JSON.stringify({ errorCode, retryable })],
    );
    await db.query(
      `INSERT INTO extraction_run_issues (
         id, user_id, document_id, extraction_run_id, code, severity,
         recoverable, metadata_no_sensitive
       ) VALUES ($1, $2, $3, $4, $5, 'ERROR', $6, '{}'::jsonb)
       ON CONFLICT (extraction_run_id, code, affected_field_path) DO NOTHING`,
      [randomUUID(), job.user_id, job.document_id, runId, errorCode, error.retryable],
    );
    if (errorCode === 'DOCUMENT_MALWARE_DETECTED') {
      await db.query(
        `UPDATE documents SET security_status = 'QUARANTINED', processing_status = 'QUARANTINED'
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [job.document_id, job.user_id],
      );
      await db.query(
        `UPDATE import_batch_items SET status = 'REJECTED', error_code = $3, updated_at = now()
          WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $1 AND user_id = $2)`,
        [job.document_id, job.user_id, errorCode],
      );
    } else if (!isReprocessingJob(job) && retryable) {
      await db.query(
        `UPDATE documents SET security_status = CASE WHEN security_status = 'CLEAN' THEN security_status ELSE 'ERROR' END,
                              processing_status = 'FAILED_RETRYABLE'
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [job.document_id, job.user_id],
      );
      await db.query(
        `UPDATE import_batch_items SET status = 'PROCESSING', error_code = $3, updated_at = now()
          WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $1 AND user_id = $2)`,
        [job.document_id, job.user_id, errorCode],
      );
    } else if (!retryable) {
      restoredPreviousState = await persistPermanentFailureState(db, job, errorCode);
    }
    if (!retryable && !restoredPreviousState
      && (!isReprocessingJob(job) || errorCode === 'DOCUMENT_MALWARE_DETECTED')) {
      await scheduleRetentionDeletion(db, job);
    }
    if (isReprocessingJob(job) && !retryable) {
      await auditFailedReprocessingRun(
        db,
        job,
        runId,
        errorCode,
        activeBefore?.rows[0]?.active_extraction_run_id ?? null,
      );
    }
    if (isReprocessingJob(job)) await refreshReprocessingBatch(db, job);
    else await completeBatchIfTerminal(db, job);
  });
  log('job_failed', { errorCode, jobId: job.id, retryable: retryable ? 1 : 0 });
}

async function processJob(
  jobId: string,
  workerId: string,
  s3: S3Client,
  config: WorkerConfig,
): Promise<void> {
  const claim = await claimJob(jobId, workerId, config);
  if (!claim) return;
  const { document, job } = claim;
  const started = Date.now();
  let directory: string | null = null;
  try {
    if (isReprocessingJob(job)) {
      const artifact = await loadCompatibleTextArtifact(s3, config, job);
      if (artifact) {
        const automaticClassification = classifyPayrollText(
          artifact.text,
          config.classificationLowThreshold,
          config.classificationHighThreshold,
        );
        const classification: Classification = {
          ...automaticClassification,
          decision: 'SUPPORTED',
          documentType: 'PAYROLL',
          signals: [...automaticClassification.signals, 'compatible_text_artifact'],
        };
        await setDocumentStage(job, 'PARSING');
        const extraction = attachSpatialEvidence(
          extractArgentinePayroll(artifact.text, artifact.source),
          artifact.evidence,
        );
        const result = await persistExtraction(
          job,
          classification,
          extraction,
          artifact.source,
          false,
          Date.now() - started,
        );
        log('job_completed', { jobId: job.id, result: result ?? 'STALE' });
        return;
      }
    }
    directory = await mkdtemp(join(tmpdir(), 'salarivo-job-'));
    const pdfPath = join(directory, 'document.pdf');
    const checksum = await downloadObject(s3, config, document, pdfPath);
    const pages = await inspectPdf(pdfPath, config);
    await scanWithClamAv(pdfPath, config);
    await inspectActiveContent(pdfPath, config);
    await setDocumentStage(job, 'DOCUMENT_CLASSIFICATION', {
      detected_mime_type: 'application/pdf',
      page_count: pages,
      security_status: 'CLEAN',
      sha256: checksum,
    });

    let source: FieldSource = 'PDF_TEXT';
    let sample = await extractPdfText(pdfPath, Math.min(2, pages), config);
    if (sample.text.length < 80) {
      source = 'OCR';
      sample = await extractOcrText(pdfPath, 1, directory, config);
    }
    const automaticClassification = classifyPayrollText(
      sample.text,
      config.classificationLowThreshold,
      config.classificationHighThreshold,
    );
    const classification: Classification = jobTrigger(job) === 'USER_TYPE_CONFIRMATION'
      ? {
          ...automaticClassification,
          decision: 'SUPPORTED',
          documentType: 'PAYROLL',
          signals: [...automaticClassification.signals, 'user_type_confirmation'],
        }
      : automaticClassification;
    if (classification.decision !== 'SUPPORTED') {
      await finishClassification(job, classification, source, Date.now() - started);
      log('job_completed', { jobId: job.id, result: classification.decision });
      return;
    }

    await setDocumentStage(job, source === 'OCR' ? 'OCR' : 'TEXT_EXTRACTION', {
      classification_confidence: classification.confidence,
      classification_status: 'SUPPORTED',
      document_type: 'PAYROLL',
    });
    let partialOcr = false;
    let extracted: TextExtraction;
    if (source === 'OCR') {
      if (pages === 1) {
        extracted = sample;
      } else {
        const ocr = await extractOcrText(pdfPath, pages, directory, config);
        extracted = ocr;
        partialOcr = ocr.partial;
      }
    } else {
      extracted = pages <= 2 ? sample : await extractPdfText(pdfPath, pages, config);
      if (extracted.text.length < 80) {
        source = 'OCR';
        const ocr = await extractOcrText(pdfPath, pages, directory, config);
        extracted = ocr;
        partialOcr = ocr.partial;
      }
    }
    if (extracted.text.length < 40) throw new WorkerError('DOCUMENT_TEXT_UNREADABLE', false);

    const run = await pool.query<{ id: string }>(
      `SELECT id FROM extraction_runs
        WHERE user_id = $1 AND document_id = $2 AND processing_version = $3
          AND status = 'PROCESSING'`,
      [job.user_id, job.document_id, job.processing_version],
    );
    const runId = run.rows[0]?.id;
    if (!runId) throw new WorkerError('EXTRACTION_PERSISTENCE_CONFLICT', true);
    await persistTextArtifact(s3, config, job, runId, extracted,
      source === 'OCR' ? 'OCR' : 'PDF_TEXT', partialOcr, pages);
    await setDocumentStage(job, 'PARSING');
    const extraction = attachSpatialEvidence(
      extractArgentinePayroll(extracted.text, source === 'OCR' ? 'OCR' : 'PDF_TEXT'),
      extracted.evidence,
    );
    const result = await persistExtraction(job, classification, extraction, source, partialOcr, Date.now() - started);
    log('job_completed', { jobId: job.id, result: result ?? 'STALE' });
  } catch (error) {
    await failJob(job, error);
  } finally {
    let removed = true;
    if (directory) {
      try {
        await rm(directory, { force: true, recursive: true });
      } catch {
        removed = false;
        log('job_temp_cleanup_failed', { jobId: job.id });
      }
    }
    if (removed) {
      await pool.query(
        `UPDATE processing_jobs SET execution_owner = NULL, updated_at = now()
          WHERE id = $1 AND execution_owner = $2`,
        [job.id, workerId],
      );
    }
  }
}

async function dispatcherLoop(
  client: QueuePublisher,
  config: WorkerConfig,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const count = await dispatchOnce(client, config);
      if (count) log('jobs_published', { count });
    } catch {
      log('dispatcher_error');
    }
    await new Promise((resolve) => setTimeout(resolve, config.dispatcherPollMs));
  }
}

async function maintenanceLoop(s3: S3Client, config: WorkerConfig, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const reconciled = await reconcileDatabaseState(config);
      if (reconciled.exhausted) log('jobs_exhausted', { count: reconciled.exhausted });
      if (reconciled.recovered) log('job_leases_recovered', { count: reconciled.recovered });
      if (reconciled.released) log('job_execution_owners_released', { count: reconciled.released });
      if (reconciled.batches) log('batches_completed', { count: reconciled.batches });
      const cleaned = await cleanupExpiredUploads(s3, config);
      if (cleaned.objects) log('uploads_cleaned', { count: cleaned.objects });
      if (cleaned.items) log('upload_items_cancelled', { count: cleaned.items });
      if (cleaned.batches) log('batches_completed', { count: cleaned.batches });
      const expiredMfa = await cleanupExpiredMfaEnrollments();
      if (expiredMfa) log('mfa_enrollments_expired', { count: expiredMfa });
      let tombstones = 0;
      const visitedTombstoneUsers = new Set<string>();
      for (let index = 0; index < 100; index += 1) {
        let cleaned = await cleanupStorageDeletionTombstone(s3, config, [...visitedTombstoneUsers]);
        if (!cleaned && visitedTombstoneUsers.size) {
          visitedTombstoneUsers.clear();
          cleaned = await cleanupStorageDeletionTombstone(s3, config, []);
        }
        if (!cleaned) break;
        visitedTombstoneUsers.add(cleaned.userId);
        tombstones += cleaned.deleted;
      }
      if (tombstones) log('storage_deletions_completed', { count: tombstones });
      let accounts = 0;
      for (let index = 0; index < 10; index += 1) {
        const deleted = await cleanupPendingAccounts(config);
        if (!deleted) break;
        accounts += deleted;
      }
      if (accounts) log('accounts_deleted', { count: accounts });
    } catch {
      log('maintenance_error');
    }
    try {
      await sleep(60_000, undefined, { signal });
    } catch (error) {
      if ((error as Error).name !== 'AbortError') throw error;
    }
  }
}

async function consumerLoop(
  client: QueueConsumer,
  workerId: string,
  s3: S3Client,
  config: WorkerConfig,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    let message;
    try {
      message = await client.brPop(QUEUE_NAME, 2);
    } catch {
      log('queue_receive_error');
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    if (!message) continue;
    const jobId = parseJobMessage(message.element);
    if (!jobId) {
      log('queue_message_rejected');
      continue;
    }
    await processJob(jobId, workerId, s3, config);
  }
}

async function queueRuntime(s3: S3Client, config: WorkerConfig, signal: AbortSignal): Promise<void> {
  const publisher = createClient({ url: config.queueUrl });
  publisher.on('error', () => log('queue_connection_error'));
  const consumers: QueueWorkerClient[] = [];
  const stop = () => {
    if (publisher.isOpen) publisher.destroy();
    for (const client of consumers) if (client.isOpen) client.destroy();
  };
  signal.addEventListener('abort', stop, { once: true });
  const workerId = randomUUID();
  try {
    await publisher.connect();
    if (signal.aborted) return;
    for (let index = 0; index < config.workerConcurrency; index += 1) {
      const client = publisher.duplicate();
      client.on('error', () => log('queue_connection_error'));
      consumers.push(client);
      await client.connect();
      if (signal.aborted) return;
    }
    log('worker_started', { concurrency: config.workerConcurrency });
    await Promise.all([
      dispatcherLoop(publisher, config, signal),
      ...consumers.map((client, index) =>
        consumerLoop(client, `${workerId}:${index}`, s3, config, signal)),
    ]);
  } finally {
    signal.removeEventListener('abort', stop);
    stop();
  }
}

async function queueSupervisor(s3: S3Client, config: WorkerConfig, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await queueRuntime(s3, config, signal);
    } catch {
      if (signal.aborted) return;
      log('queue_start_failed');
      try {
        await sleep(1_000, undefined, { signal });
      } catch (error) {
        if ((error as Error).name !== 'AbortError') throw error;
      }
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  startupStage = 'migrations';
  await migrate();
  const s3 = new S3Client({
    credentials: { accessKeyId: config.storageAccessKey, secretAccessKey: config.storageSecretKey },
    endpoint: config.storageEndpoint,
    forcePathStyle: true,
    region: config.storageRegion,
  });
  startupStage = 'storage';
  await verifyProductionStorage(s3, config);
  startupStage = 'runtime';
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const maintenance = maintenanceLoop(s3, config, abort.signal);
  const queue = queueSupervisor(s3, config, abort.signal);
  log('worker_maintenance_started');
  try {
    await Promise.all([maintenance, queue]);
  } finally {
    abort.abort();
    await Promise.allSettled([maintenance, queue]);
    await pool.end().catch(() => undefined);
    s3.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    log('worker_start_failed', { stage: startupStage });
    process.exitCode = 1;
  });
}
