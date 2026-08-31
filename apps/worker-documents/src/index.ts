import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { migrate, pool, withTransaction } from '@salarivo/database';
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
const WORKER_VERSION = '6';
const STORAGE_REQUEST_TIMEOUT_MS = 30_000;
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
  document_id: string;
  id: string;
  lease_owner: string;
  max_attempts: number;
  previous_document_status: 'COMPLETED' | 'NEEDS_REVIEW' | 'FAILED_PERMANENT' | 'CANCELLED' | null;
  processing_version: number;
  stage: 'SECURITY_VALIDATION' | 'TEXT_EXTRACTION';
  user_id: string;
};

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
const evidenceOutputLimit = (config: WorkerConfig) => Math.min(16 * 1024 * 1024, config.maxTextBytes * 4);

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

type RestorableJob = Pick<JobRow, 'document_id' | 'previous_document_status' | 'user_id'>;

async function persistPermanentFailureState(
  db: PoolClient,
  job: RestorableJob,
  errorCode: string,
  failureSecurityStatus: 'ERROR' | 'REJECTED' = 'REJECTED',
): Promise<boolean> {
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

async function reconcileDatabaseState(
  config: WorkerConfig,
): Promise<{ batches: number; exhausted: number; recovered: number }> {
  return await withTransaction(async (db: PoolClient) => {
    const expired = await db.query<{
      document_id: string;
      previous_document_status: JobRow['previous_document_status'];
      state: 'FAILED' | 'RETRYABLE';
      user_id: string;
    }>(
      `WITH candidates AS (
         SELECT job.id, job.attempt >= job.max_attempts AS exhausted
           FROM processing_jobs AS job
           JOIN users ON users.id = job.user_id AND users.status = 'ACTIVE'
          WHERE job.state = 'RUNNING' AND job.lease_expires_at < now()
          ORDER BY job.lease_expires_at
          FOR UPDATE OF job SKIP LOCKED
          LIMIT $1
       )
       UPDATE processing_jobs AS job
          SET state = CASE WHEN candidates.exhausted THEN 'FAILED' ELSE 'RETRYABLE' END,
              available_at = CASE WHEN candidates.exhausted THEN job.available_at ELSE now() END,
              completed_at = CASE WHEN candidates.exhausted THEN now() ELSE NULL END,
              lease_owner = NULL, lease_expires_at = NULL,
              error_code = CASE WHEN candidates.exhausted
                THEN 'WORKER_LEASE_EXHAUSTED' ELSE 'WORKER_LEASE_EXPIRED' END,
              updated_at = now()
         FROM candidates
        WHERE job.id = candidates.id
        RETURNING job.user_id, job.document_id, job.state, job.previous_document_status`,
      [config.dispatcherBatchSize],
    );
    const exhausted = expired.rows.filter((job) => job.state === 'FAILED');
    for (const job of exhausted) {
      const restored = await persistPermanentFailureState(db, job, 'WORKER_LEASE_EXHAUSTED', 'ERROR');
      await completeBatchIfTerminal(db, job);
      if (!restored) await scheduleRetentionDeletion(db, job);
    }
    const batches = await completeTerminalBatches(db);
    return {
      batches,
      exhausted: exhausted.length,
      recovered: expired.rows.length - exhausted.length,
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
          WHERE job.stage IN ('SECURITY_VALIDATION', 'TEXT_EXTRACTION')
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
      [config.publishedRetryMs, config.dispatcherBatchSize + config.workerConcurrency],
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
    canonical_object_key: string;
    id: string;
    incoming_object_key: string;
    user_id: string;
  }>(
    `WITH candidate AS (
       SELECT tombstone.id
         FROM storage_deletion_tombstones AS tombstone
        WHERE tombstone.upload_expires_at <= now() - ($1 * interval '1 millisecond')
          AND NOT (tombstone.user_id = ANY($2::uuid[]))
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
                tombstone.incoming_object_key, tombstone.attempt, tombstone.user_id`,
    [config.uploadCleanupGraceMs, excludedUserIds, leaseOwner],
  );
  const tombstone = claimed.rows[0];
  if (!tombstone) return null;
  try {
    for (const key of new Set([tombstone.canonical_object_key, tombstone.incoming_object_key])) {
      await deleteStorageObject(s3, config.storageBucket, key);
    }
    const completed = await pool.query(
      `DELETE FROM storage_deletion_tombstones
        WHERE id = $1 AND status = 'RUNNING' AND lease_owner = $2`,
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
      || !['SECURITY_VALIDATION', 'TEXT_EXTRACTION'].includes(pending.stage)
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
        WHERE id = $1 AND stage IN ('SECURITY_VALIDATION', 'TEXT_EXTRACTION') AND state = 'PUBLISHED'
          AND available_at <= now() AND attempt < max_attempts
          AND execution_owner IS NULL
          AND EXISTS (SELECT 1 FROM users WHERE id = processing_jobs.user_id AND status = 'ACTIVE')
          AND (SELECT count(*) FROM processing_jobs active
                WHERE active.user_id = processing_jobs.user_id AND active.state = 'RUNNING') < $4
        RETURNING id, user_id, document_id, processing_version, stage, attempt, max_attempts,
                  lease_owner, previous_document_status`,
      [jobId, workerId, config.jobLeaseMs, config.workerConcurrencyPerUser],
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
      await db.query(
        `UPDATE processing_jobs
            SET state = 'CANCELLED', completed_at = now(), lease_owner = NULL,
                lease_expires_at = NULL, execution_owner = NULL,
                error_code = 'DOCUMENT_DELETED', updated_at = now()
          WHERE id = $1`,
        [job.id],
      );
      return null;
    }
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
      WORKER_VERSION,
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
    const run = await db.query<{ id: string }>(
      `INSERT INTO extraction_runs (
         id, user_id, document_id, processing_version, status,
         classifier_name, classifier_version, extractor_name, extractor_version,
         parser_version, normalizer_version, ocr_provider, ocr_version,
         started_at, finished_at, confidence, compute_ms
       ) VALUES ($1, $2, $3, $4, 'COMPLETED', 'heuristic-ar-payroll', $5,
         'classification-only', $5, $5, $5, $6, $7, now(), now(), $8, $9)
       ON CONFLICT (document_id, processing_version) DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        job.user_id,
        job.document_id,
        job.processing_version,
        WORKER_VERSION,
        source === 'OCR' ? 'tesseract' : null,
        source === 'OCR' ? 'spa' : null,
        classification.confidence,
        computeMs,
      ],
    );
    const runId = run.rows[0]?.id;
    if (runId) await insertClassificationField(db, job, runId, classification);
    await db.query(
      `UPDATE documents
          SET classification_status = $3, document_type = $4,
              classification_confidence = $5, processing_status = $6, processed_at = now()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [job.document_id, job.user_id, classification.decision, null, classification.confidence, processingStatus],
    );
    await db.query(
      `UPDATE import_batch_items
          SET status = $3, error_code = $4, updated_at = now()
        WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $1 AND user_id = $2)`,
      [
        job.document_id,
        job.user_id,
        classification.decision === 'UNSUPPORTED' ? 'REJECTED' : 'NEEDS_REVIEW',
        classification.decision === 'UNSUPPORTED' ? 'DOCUMENT_UNSUPPORTED' : 'DOCUMENT_LOW_CONFIDENCE',
      ],
    );
    if (classification.decision === 'UNSUPPORTED') await scheduleRetentionDeletion(db, job);
    await db.query(
      `UPDATE processing_jobs
          SET state = 'COMPLETED', completed_at = now(), lease_owner = NULL,
              lease_expires_at = NULL, error_code = NULL, updated_at = now()
        WHERE id = $1 AND state = 'RUNNING' AND lease_owner = $2`,
      [job.id, job.lease_owner],
    );
    await completeBatchIfTerminal(db, job);
  });
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
    const activeJob = await db.query(
      `SELECT 1 FROM processing_jobs
        WHERE id = $1 AND state = 'RUNNING' AND document_id = $2 AND user_id = $3 AND lease_owner = $4
        FOR UPDATE`,
      [job.id, job.document_id, job.user_id, job.lease_owner],
    );
    if (!activeJob.rowCount) return null;
    const activeDocument = await db.query(
      `SELECT 1 FROM documents WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
      [job.document_id, job.user_id],
    );
    if (!activeDocument.rowCount) {
      await db.query(
        `UPDATE processing_jobs
            SET state = 'CANCELLED', completed_at = now(), lease_owner = NULL,
                lease_expires_at = NULL, updated_at = now()
          WHERE id = $1 AND lease_owner = $2`,
        [job.id, job.lease_owner],
      );
      return null;
    }

    const inserted = await db.query<{ id: string }>(
      `INSERT INTO extraction_runs (
         id, user_id, document_id, processing_version, status,
         classifier_name, classifier_version, extractor_name, extractor_version,
         parser_version, normalizer_version, ocr_provider, ocr_version,
         started_at, finished_at, confidence, compute_ms
       ) VALUES ($1, $2, $3, $4, 'COMPLETED', 'heuristic-ar-payroll', $5,
         'deterministic-ar-payroll', $5, $5, $5, $6, $7, now(), now(), $8, $9)
       ON CONFLICT (document_id, processing_version) DO NOTHING
       RETURNING id`,
      [
        randomUUID(),
        job.user_id,
        job.document_id,
        job.processing_version,
        WORKER_VERSION,
        source === 'OCR' ? 'tesseract' : null,
        source === 'OCR' ? 'spa' : null,
        classification.confidence,
        computeMs,
      ],
    );
    let runId = inserted.rows[0]?.id;
    if (!runId) {
      const existing = await db.query<{ id: string }>(
        `SELECT id FROM extraction_runs
          WHERE document_id = $1 AND processing_version = $2 AND status = 'COMPLETED'`,
        [job.document_id, job.processing_version],
      );
      runId = existing.rows[0]?.id;
    }
    if (!runId) throw new WorkerError('EXTRACTION_PERSISTENCE_CONFLICT', true);

    let effectiveExtraction = extraction;
    if (inserted.rowCount) {
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
            WORKER_VERSION,
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
          WHERE correction.user_id = $1 AND correction.document_id = $2
            AND previous_run.status = 'COMPLETED'
            AND previous_run.processing_version < $4
          ORDER BY correction.field_path, previous_run.processing_version DESC,
                   correction.correction_version DESC, correction.created_at DESC, correction.id DESC`,
        [job.user_id, job.document_id, runId, job.processing_version],
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

    const needsReview = job.previous_document_status === 'NEEDS_REVIEW'
      || partialOcr
      || payrollExtractionNeedsReview(effectiveExtraction);
    await db.query(
      `UPDATE documents
          SET classification_status = 'SUPPORTED', document_type = 'PAYROLL',
              classification_confidence = $3, processing_status = $4, processed_at = now()
        WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [job.document_id, job.user_id, classification.confidence, needsReview ? 'NEEDS_REVIEW' : 'COMPLETED'],
    );
    await db.query(
      `UPDATE import_batch_items
          SET status = $3, error_code = NULL, updated_at = now()
        WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $1 AND user_id = $2)`,
      [job.document_id, job.user_id, needsReview ? 'NEEDS_REVIEW' : 'COMPLETED'],
    );
    if (!needsReview) await scheduleRetentionDeletion(db, job);
    await db.query(
      `UPDATE processing_jobs
          SET state = 'COMPLETED', completed_at = now(), lease_owner = NULL,
              lease_expires_at = NULL, error_code = NULL, updated_at = now()
        WHERE id = $1 AND state = 'RUNNING' AND lease_owner = $2`,
      [job.id, job.lease_owner],
    );
    await completeBatchIfTerminal(db, job);
    return needsReview ? 'NEEDS_REVIEW' : 'COMPLETED';
  });
}

function normalizeError(error: unknown): WorkerError {
  return error instanceof WorkerError ? error : new WorkerError('WORKER_INTERNAL_ERROR', true);
}

export async function failJob(job: JobRow, rawError: unknown): Promise<void> {
  const error = normalizeError(rawError);
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
      [job.id, job.user_id, retryable ? 'RETRYABLE' : 'FAILED', delayMs, error.code.slice(0, 64), job.lease_owner],
    );
    if (!updated.rowCount) return;
    if (error.code === 'DOCUMENT_MALWARE_DETECTED') {
      await db.query(
        `UPDATE documents SET security_status = 'QUARANTINED', processing_status = 'QUARANTINED'
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [job.document_id, job.user_id],
      );
      await db.query(
        `UPDATE import_batch_items SET status = 'REJECTED', error_code = $3, updated_at = now()
          WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $1 AND user_id = $2)`,
        [job.document_id, job.user_id, error.code],
      );
    } else if (retryable) {
      await db.query(
        `UPDATE documents SET security_status = CASE WHEN security_status = 'CLEAN' THEN security_status ELSE 'ERROR' END,
                              processing_status = 'FAILED_RETRYABLE'
          WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [job.document_id, job.user_id],
      );
      await db.query(
        `UPDATE import_batch_items SET status = 'PROCESSING', error_code = $3, updated_at = now()
          WHERE id = (SELECT import_batch_item_id FROM documents WHERE id = $1 AND user_id = $2)`,
        [job.document_id, job.user_id, error.code],
      );
    } else {
      restoredPreviousState = await persistPermanentFailureState(db, job, error.code);
    }
    if (!retryable && !restoredPreviousState) await scheduleRetentionDeletion(db, job);
    await completeBatchIfTerminal(db, job);
  });
  log('job_failed', { errorCode: error.code, jobId: job.id, retryable: retryable ? 1 : 0 });
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
    const classification: Classification = job.stage === 'TEXT_EXTRACTION'
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
