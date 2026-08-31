import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAwsStoragePolicy,
  assertProductionStorageConfig,
  assertR2StoragePolicy,
  objectStorageProvider,
  verifyProductionStorage,
} from '../src/storage.ts';
import type { S3Client } from '@aws-sdk/client-s3';

const r2Config = {
  appEnv: 'production' as const,
  cloudflareAccountId: '0123456789abcdef0123456789abcdef',
  cloudflareApiToken: 'read-only-token',
  publicOrigin: 'https://www.salarivo.cloud',
  storageBucket: 'salarivo-documents',
  storageEndpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
  storageKmsKeyId: null,
  storageProvider: 'r2' as const,
  storageRegion: 'auto',
};

const r2Policy = {
  bucket: { name: 'salarivo-documents', storage_class: 'Standard' },
  cors: {
    rules: [{
      allowed: {
        headers: ['Content-Type', 'If-Match', 'x-amz-meta-upload-session', 'x-amz-storage-class'],
        methods: ['PUT'],
        origins: ['https://www.salarivo.cloud'],
      },
      exposeHeaders: ['ETag'],
      maxAgeSeconds: 300,
    }, {
      allowed: {
        headers: ['Range'],
        methods: ['GET', 'HEAD'],
        origins: ['https://www.salarivo.cloud'],
      },
      exposeHeaders: ['Accept-Ranges', 'Content-Disposition', 'Content-Length', 'Content-Range', 'Content-Type', 'ETag'],
      maxAgeSeconds: 300,
    }],
  },
  customDomains: { domains: [] },
  lifecycle: {
    rules: [{
      abortMultipartUploadsTransition: { condition: { maxAge: 604_800, type: 'Age' } },
      conditions: { prefix: '' },
      enabled: true,
    }, {
      abortMultipartUploadsTransition: { condition: { maxAge: 86_400, type: 'Age' } },
      conditions: { prefix: 'incoming/' },
      deleteObjectsTransition: { condition: { maxAge: 86_400, type: 'Age' } },
      enabled: true,
    }],
  },
  locks: { rules: [] },
  managedDomain: { enabled: false },
  sippy: { enabled: false },
};

test('R2 production configuration is explicit and exact', () => {
  assert.equal(objectStorageProvider(undefined, false), 'aws');
  assert.throws(() => objectStorageProvider(undefined, true), /Missing required/);
  assert.throws(() => objectStorageProvider('minio', true), /aws or r2/);
  assert.doesNotThrow(() => assertProductionStorageConfig(r2Config));
  assert.throws(() => assertProductionStorageConfig({ ...r2Config, storageKmsKeyId: 'kms' }), /absent/);
  assert.throws(() => assertProductionStorageConfig({ ...r2Config, storageRegion: 'us-east-1' }), /auto/);
  assert.throws(() => assertProductionStorageConfig({ ...r2Config, storageEndpoint: 'https://example.com' }), /exact R2/);
  assert.throws(() => assertProductionStorageConfig({ ...r2Config, publicOrigin: 'https://www.salarivo.cloud/path' }), /exact HTTPS origin/);
  assert.throws(() => assertProductionStorageConfig({ ...r2Config, cloudflareApiToken: null }), /API_TOKEN/);
});

test('R2 production policy stays private with exact upload and download CORS', () => {
  assert.doesNotThrow(() => assertR2StoragePolicy(r2Policy, r2Config.storageBucket, r2Config.publicOrigin));
  assert.throws(() => assertR2StoragePolicy({ ...r2Policy, managedDomain: { enabled: true } }, r2Config.storageBucket, r2Config.publicOrigin), /r2.dev/);
  assert.throws(() => assertR2StoragePolicy({ ...r2Policy, customDomains: { domains: [{ enabled: true }] } }, r2Config.storageBucket, r2Config.publicOrigin), /custom domains/);
  assert.throws(() => assertR2StoragePolicy({ ...r2Policy, customDomains: { domains: [{}] } }, r2Config.storageBucket, r2Config.publicOrigin), /custom domains/);
  assert.throws(() => assertR2StoragePolicy({ ...r2Policy, locks: { rules: [{ enabled: true }] } }, r2Config.storageBucket, r2Config.publicOrigin), /lock rules/);
  assert.throws(() => assertR2StoragePolicy({ ...r2Policy, sippy: { enabled: true } }, r2Config.storageBucket, r2Config.publicOrigin), /on-demand migration/);
  assert.throws(() => assertR2StoragePolicy({ ...r2Policy, cors: { rules: [{ allowed: { headers: ['*'], methods: ['GET', 'PUT'], origins: ['*'] } }] } }, r2Config.storageBucket, r2Config.publicOrigin), /CORS/);
  assert.throws(() => assertR2StoragePolicy({ ...r2Policy, cors: { rules: [{ ...r2Policy.cors.rules[0], exposeHeaders: [] }, r2Policy.cors.rules[1]] } }, r2Config.storageBucket, r2Config.publicOrigin), /CORS/);
  assert.throws(() => assertR2StoragePolicy({ ...r2Policy, cors: { rules: [r2Policy.cors.rules[0], { ...r2Policy.cors.rules[1], maxAgeSeconds: 301 }] } }, r2Config.storageBucket, r2Config.publicOrigin), /CORS/);
  assert.throws(() => assertR2StoragePolicy({ ...r2Policy, cors: { rules: [r2Policy.cors.rules[0], { ...r2Policy.cors.rules[1], allowed: { ...r2Policy.cors.rules[1]!.allowed, headers: ['*'] } }] } }, r2Config.storageBucket, r2Config.publicOrigin), /CORS/);
  assert.throws(() => assertR2StoragePolicy({ ...r2Policy, lifecycle: { rules: [] } }, r2Config.storageBucket, r2Config.publicOrigin), /lifecycle/);
  assert.throws(() => assertR2StoragePolicy({ ...r2Policy, lifecycle: { rules: [...r2Policy.lifecycle.rules, {
    conditions: { prefix: '' },
    deleteObjectsTransition: { condition: { maxAge: 86_400, type: 'Age' } },
    enabled: true,
  }] } }, r2Config.storageBucket, r2Config.publicOrigin), /lifecycle/);
  assert.throws(() => assertR2StoragePolicy({ ...r2Policy, bucket: { ...r2Policy.bucket, storage_class: 'InfrequentAccess' } }, r2Config.storageBucket, r2Config.publicOrigin), /Standard/);
});

test('R2 startup verification uses only read-only Cloudflare API calls', async () => {
  const requests: Array<{ authorization: string | null; method: string; url: string }> = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      authorization: new Headers(init?.headers).get('authorization'),
      method: init?.method ?? 'GET',
      url,
    });
    const result = url.endsWith('/cors')
      ? r2Policy.cors
      : url.endsWith('/lifecycle')
        ? r2Policy.lifecycle
        : url.endsWith('/domains/managed')
          ? r2Policy.managedDomain
          : url.endsWith('/domains/custom')
            ? r2Policy.customDomains
            : url.endsWith('/lock')
              ? r2Policy.locks
              : url.endsWith('/sippy')
                ? r2Policy.sippy
            : r2Policy.bucket;
    return Response.json({ result, success: true });
  }) as typeof fetch;
  let s3Calls = 0;
  const s3 = { send: async (command: { input: unknown }) => {
    s3Calls += 1;
    assert.deepEqual(command.input, { Bucket: r2Config.storageBucket, MaxKeys: 1 });
    return {};
  } } as unknown as S3Client;

  await verifyProductionStorage(s3, r2Config, fetcher);

  assert.equal(requests.length, 7);
  assert.equal(s3Calls, 1);
  assert.ok(requests.every(({ method }) => method === 'GET'));
  assert.ok(requests.every(({ authorization }) => authorization === 'Bearer read-only-token'));
});

test('AWS production policy still requires KMS, no versioning and full public access block', () => {
  const encryption = {
    ServerSideEncryptionConfiguration: {
      Rules: [{ ApplyServerSideEncryptionByDefault: { KMSMasterKeyID: 'kms', SSEAlgorithm: 'aws:kms' as const } }],
    },
    $metadata: {},
  };
  const access = {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    $metadata: {},
  };
  assert.doesNotThrow(() => assertAwsStoragePolicy({ $metadata: {} }, encryption, access, 'kms'));
  assert.throws(() => assertAwsStoragePolicy({ Status: 'Enabled', $metadata: {} }, encryption, access, 'kms'), /versioning/);
  assert.throws(() => assertAwsStoragePolicy({ $metadata: {} }, encryption, access, 'other'), /KMS/);
  assert.throws(() => assertAwsStoragePolicy({ $metadata: {} }, encryption, { ...access, PublicAccessBlockConfiguration: { ...access.PublicAccessBlockConfiguration, RestrictPublicBuckets: false } }, 'kms'), /public access/);
});
