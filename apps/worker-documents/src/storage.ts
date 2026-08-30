import {
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  ListObjectsV2Command,
  type GetBucketEncryptionCommandOutput,
  type GetBucketVersioningCommandOutput,
  type GetPublicAccessBlockCommandOutput,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { RuntimeEnvironment } from './environment.ts';

const STORAGE_REQUEST_TIMEOUT_MS = 30_000;
const R2_LIFECYCLE_AGE_SECONDS = 86_400;
const R2_UPLOAD_HEADERS = [
  'content-type',
  'if-match',
  'x-amz-meta-upload-session',
  'x-amz-storage-class',
];

export type StorageProvider = 'aws' | 'r2';

export function objectStorageProvider(value: string | undefined, production: boolean): StorageProvider {
  const configured = value?.trim() || (production ? null : 'aws');
  if (!configured) throw new Error('Missing required environment variable: OBJECT_STORAGE_PROVIDER');
  if (configured !== 'aws' && configured !== 'r2') throw new Error('OBJECT_STORAGE_PROVIDER must be aws or r2');
  return configured;
}

type StorageConfig = {
  appEnv: RuntimeEnvironment;
  cloudflareAccountId: string | null;
  cloudflareApiToken: string | null;
  publicOrigin: string | null;
  storageBucket: string;
  storageEndpoint: string;
  storageKmsKeyId: string | null;
  storageProvider: StorageProvider;
  storageRegion: string;
};

type R2Policy = {
  bucket: { name?: unknown; storage_class?: unknown };
  cors: {
    rules?: unknown;
  };
  customDomains: { domains?: unknown };
  lifecycle: { rules?: unknown };
  locks: { rules?: unknown };
  managedDomain: { enabled?: unknown };
  sippy: { enabled?: unknown };
};

function exactStrings(actual: unknown, expected: string[], lowercase = false): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length || !actual.every((value) => typeof value === 'string')) return false;
  const normalize = (value: string) => lowercase ? value.toLowerCase() : value;
  const normalizedExpected = expected.map(normalize).sort();
  return actual.map(normalize).sort().every((value, index) => value === normalizedExpected[index]);
}

function exactHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' && parsed.origin === value;
  } catch {
    return false;
  }
}

export function assertProductionStorageConfig(config: StorageConfig): void {
  if (config.appEnv !== 'production') return;
  if (config.storageProvider === 'aws') {
    if (!config.storageKmsKeyId) throw new Error('OBJECT_STORAGE_KMS_KEY_ID is required for AWS');
    return;
  }
  if (!/^[a-f0-9]{32}$/.test(config.cloudflareAccountId ?? '')) throw new Error('CLOUDFLARE_ACCOUNT_ID is invalid');
  if (!config.cloudflareApiToken) throw new Error('CLOUDFLARE_R2_API_TOKEN is required for R2');
  if (config.storageKmsKeyId) throw new Error('OBJECT_STORAGE_KMS_KEY_ID must be absent for R2');
  if (config.storageEndpoint !== `https://${config.cloudflareAccountId}.r2.cloudflarestorage.com`) {
    throw new Error('OBJECT_STORAGE_ENDPOINT must be the exact R2 account endpoint');
  }
  if (config.storageRegion !== 'auto') throw new Error('OBJECT_STORAGE_REGION must be auto for R2');
  if (!config.publicOrigin || !exactHttpsOrigin(config.publicOrigin)) throw new Error('PUBLIC_ORIGIN must be an exact HTTPS origin for R2');
}

export function assertAwsStoragePolicy(
  versioning: GetBucketVersioningCommandOutput,
  encryption: GetBucketEncryptionCommandOutput,
  access: GetPublicAccessBlockCommandOutput,
  kmsKeyId: string,
): void {
  if (versioning.Status !== undefined) throw new Error('OBJECT_STORAGE_BUCKET must never have versioning enabled');
  const kms = encryption.ServerSideEncryptionConfiguration?.Rules?.some((rule) =>
    rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === 'aws:kms'
    && rule.ApplyServerSideEncryptionByDefault.KMSMasterKeyID === kmsKeyId);
  if (!kms) throw new Error('OBJECT_STORAGE_BUCKET must use the configured KMS key');
  const block = access.PublicAccessBlockConfiguration;
  if (!block?.BlockPublicAcls || !block.IgnorePublicAcls || !block.BlockPublicPolicy || !block.RestrictPublicBuckets) {
    throw new Error('OBJECT_STORAGE_BUCKET must block all public access');
  }
}

export function assertR2StoragePolicy(policy: R2Policy, bucket: string, publicOrigin: string): void {
  if (policy.bucket.name !== bucket || policy.bucket.storage_class !== 'Standard') {
    throw new Error('OBJECT_STORAGE_BUCKET must be the configured R2 Standard bucket');
  }
  if (policy.managedDomain.enabled !== false) throw new Error('OBJECT_STORAGE_BUCKET must have r2.dev disabled');
  if (!Array.isArray(policy.customDomains.domains)
    || policy.customDomains.domains.some((domain) => typeof domain !== 'object' || domain === null || (domain as { enabled?: unknown }).enabled !== false)) {
    throw new Error('OBJECT_STORAGE_BUCKET must have no enabled custom domains');
  }
  if (!Array.isArray(policy.locks.rules)
    || policy.locks.rules.some((rule) => typeof rule !== 'object' || rule === null || (rule as { enabled?: unknown }).enabled !== false)) {
    throw new Error('OBJECT_STORAGE_BUCKET must have no enabled lock rules');
  }
  if (policy.sippy.enabled !== false) throw new Error('OBJECT_STORAGE_BUCKET must disable on-demand migration');

  const corsRules = policy.cors.rules;
  if (!Array.isArray(corsRules) || corsRules.length !== 1) throw new Error('OBJECT_STORAGE_BUCKET must have the exact upload CORS policy');
  const allowed = (corsRules[0] as { allowed?: { headers?: unknown; methods?: unknown; origins?: unknown } } | undefined)?.allowed;
  if (!exactStrings(allowed?.methods, ['PUT'])
    || !exactStrings(allowed?.origins, [publicOrigin])
    || !exactStrings(allowed?.headers, R2_UPLOAD_HEADERS, true)
    || !exactStrings((corsRules[0] as { exposeHeaders?: unknown }).exposeHeaders, ['ETag'], true)
    || (corsRules[0] as { maxAgeSeconds?: unknown }).maxAgeSeconds !== 300) {
    throw new Error('OBJECT_STORAGE_BUCKET must have the exact upload CORS policy');
  }

  const lifecycleRules = policy.lifecycle.rules;
  if (!Array.isArray(lifecycleRules)) throw new Error('OBJECT_STORAGE_BUCKET must have the exact incoming lifecycle policy');
  const incomingRules = lifecycleRules.filter((candidate) => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const conditions = (candidate as { conditions?: unknown }).conditions;
    return typeof conditions === 'object' && conditions !== null && (conditions as { prefix?: unknown }).prefix === 'incoming/';
  });
  if (incomingRules.length !== 1) throw new Error('OBJECT_STORAGE_BUCKET must have the exact incoming lifecycle policy');
  const rule = incomingRules[0] as {
    abortMultipartUploadsTransition?: { condition?: { maxAge?: unknown; type?: unknown } };
    conditions?: { prefix?: unknown };
    deleteObjectsTransition?: { condition?: { maxAge?: unknown; type?: unknown } };
    enabled?: unknown;
    storageClassTransitions?: unknown;
  };
  const unsafeExtraRule = lifecycleRules.some((candidate) => {
    if (candidate === rule) return false;
    if (typeof candidate !== 'object' || candidate === null) return true;
    const extra = candidate as { deleteObjectsTransition?: unknown; storageClassTransitions?: unknown };
    return extra.deleteObjectsTransition !== undefined
      || (extra.storageClassTransitions !== undefined
        && (!Array.isArray(extra.storageClassTransitions) || extra.storageClassTransitions.length > 0));
  });
  const abort = rule.abortMultipartUploadsTransition?.condition;
  const deletion = rule.deleteObjectsTransition?.condition;
  if (rule.enabled !== true
    || rule.conditions?.prefix !== 'incoming/'
    || abort?.type !== 'Age'
    || abort.maxAge !== R2_LIFECYCLE_AGE_SECONDS
    || deletion?.type !== 'Age'
    || deletion.maxAge !== R2_LIFECYCLE_AGE_SECONDS
    || unsafeExtraRule
    || (rule.storageClassTransitions !== undefined
      && (!Array.isArray(rule.storageClassTransitions) || rule.storageClassTransitions.length > 0))) {
    throw new Error('OBJECT_STORAGE_BUCKET must have the exact incoming lifecycle policy');
  }
}

async function cloudflareGet<T>(config: StorageConfig, path: string, fetcher: typeof fetch): Promise<T> {
  const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
    cache: 'no-store',
    headers: { Authorization: `Bearer ${config.cloudflareApiToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error('Cloudflare R2 configuration check failed');
  const body = await response.json() as { result?: T; success?: unknown };
  if (body.success !== true || body.result === undefined || body.result === null) throw new Error('Cloudflare R2 configuration check failed');
  return body.result;
}

export async function verifyProductionStorage(
  s3: S3Client,
  config: StorageConfig,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (config.appEnv !== 'production') return;
  assertProductionStorageConfig(config);
  if (config.storageProvider === 'aws') {
    const [versioning, encryption, access] = await Promise.all([
      s3.send(new GetBucketVersioningCommand({ Bucket: config.storageBucket }), { abortSignal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS) }),
      s3.send(new GetBucketEncryptionCommand({ Bucket: config.storageBucket }), { abortSignal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS) }),
      s3.send(new GetPublicAccessBlockCommand({ Bucket: config.storageBucket }), { abortSignal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS) }),
    ]);
    assertAwsStoragePolicy(versioning, encryption, access, config.storageKmsKeyId!);
    return;
  }

  const path = `/accounts/${config.cloudflareAccountId}/r2/buckets/${encodeURIComponent(config.storageBucket)}`;
  const [bucket, cors, lifecycle, managedDomain, customDomains, locks, sippy] = await Promise.all([
    cloudflareGet<R2Policy['bucket']>(config, path, fetcher),
    cloudflareGet<R2Policy['cors']>(config, `${path}/cors`, fetcher),
    cloudflareGet<R2Policy['lifecycle']>(config, `${path}/lifecycle`, fetcher),
    cloudflareGet<R2Policy['managedDomain']>(config, `${path}/domains/managed`, fetcher),
    cloudflareGet<R2Policy['customDomains']>(config, `${path}/domains/custom`, fetcher),
    cloudflareGet<R2Policy['locks']>(config, `${path}/lock`, fetcher),
    cloudflareGet<R2Policy['sippy']>(config, `${path}/sippy`, fetcher),
  ]);
  assertR2StoragePolicy({ bucket, cors, lifecycle, managedDomain, customDomains, locks, sippy }, config.storageBucket, config.publicOrigin!);
  await s3.send(
    new ListObjectsV2Command({ Bucket: config.storageBucket, MaxKeys: 1 }),
    { abortSignal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS) },
  );
}
