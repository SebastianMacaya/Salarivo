import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketEncryptionCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import type { ApiConfig } from "./config.ts";

export type Storage = ReturnType<typeof createStorage>;
const STORAGE_REQUEST_TIMEOUT_MS = 30_000;
const R2_API_BASE = "https://api.cloudflare.com/client/v4";
const R2_MARKER_CONTENT_TYPE = "application/octet-stream";
const R2_SAME_KEY_WRITE_DELAY_MS = 1_100;
const R2_STORAGE_CLASS = "STANDARD" as const;
const R2_UPLOAD_CORS_HEADERS = [
  "Content-Type",
  "If-Match",
  "x-amz-meta-upload-session",
  "x-amz-storage-class",
];

export function copySource(bucket: string, key: string): string {
  return `/${encodeURIComponent(bucket)}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactStrings(value: unknown, expected: string[], caseInsensitive = false): boolean {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return false;
  const normalize = (item: string) => caseInsensitive ? item.toLowerCase() : item;
  return value.map(normalize).sort().join("\0") === expected.map(normalize).sort().join("\0");
}

function preconditionFailed(error: unknown): boolean {
  return record(error)
    && (record(error.$metadata) && error.$metadata.httpStatusCode === 412
      || error.name === "PreconditionFailed");
}

function validEtag(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
}

function retryableR2Copy(error: unknown): boolean {
  if (!record(error)) return false;
  const status = record(error.$metadata) ? error.$metadata.httpStatusCode : undefined;
  return status === 429
    || status === 503
    || error.$retryable === true
    || record(error.$retryable)
    || error.name === "AbortError"
    || error.name === "TimeoutError"
    || error.code === "ETIMEDOUT";
}

export function waitForR2WriteWindow(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, R2_SAME_KEY_WRITE_DELAY_MS));
}

export function addR2CopyDestinationIfMatch(command: CopyObjectCommand, markerEtag: string): void {
  if (!validEtag(markerEtag)) throw new Error("R2 destination marker ETag is invalid");
  command.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as { headers?: Record<string, string> };
      if (!request.headers) throw new Error("R2 copy request headers are unavailable");
      request.headers["cf-copy-destination-if-match"] = markerEtag;
      return next(args);
    },
    { name: "r2CopyDestinationIfMatch", step: "build" },
  );
}

async function cloudflareR2Result(
  config: ApiConfig,
  path: string,
  request: typeof fetch,
): Promise<unknown> {
  const response = await request(
    `${R2_API_BASE}/accounts/${config.cloudflareAccountId}/r2/buckets/${encodeURIComponent(config.storageBucket)}${path}`,
    {
      headers: { Authorization: `Bearer ${config.cloudflareR2ApiToken}` },
      signal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS),
    },
  );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Cloudflare R2 configuration API returned invalid JSON");
  }
  if (!response.ok || !record(payload) || payload.success !== true || !("result" in payload)) {
    throw new Error("Cloudflare R2 configuration API request failed");
  }
  return payload.result;
}

export async function assertR2BucketConfiguration(
  config: ApiConfig,
  request: typeof fetch = fetch,
): Promise<void> {
  if (!config.cloudflareAccountId || !config.cloudflareR2ApiToken) {
    throw new Error("Cloudflare R2 configuration credentials are missing");
  }
  const [bucket, cors, managedDomain, customDomains, lifecycle, locks, sippy] = await Promise.all([
    cloudflareR2Result(config, "", request),
    cloudflareR2Result(config, "/cors", request),
    cloudflareR2Result(config, "/domains/managed", request),
    cloudflareR2Result(config, "/domains/custom", request),
    cloudflareR2Result(config, "/lifecycle", request),
    cloudflareR2Result(config, "/lock", request),
    cloudflareR2Result(config, "/sippy", request),
  ]);

  if (!record(bucket) || bucket.name !== config.storageBucket || bucket.storage_class !== "Standard") {
    throw new Error("OBJECT_STORAGE_BUCKET must use R2 Standard storage");
  }
  if (!record(managedDomain) || managedDomain.enabled !== false) {
    throw new Error("OBJECT_STORAGE_BUCKET must disable its r2.dev domain");
  }
  if (
    !record(customDomains)
    || !Array.isArray(customDomains.domains)
    || customDomains.domains.some((domain) => !record(domain) || domain.enabled !== false)
  ) {
    throw new Error("OBJECT_STORAGE_BUCKET must not have an enabled custom domain");
  }
  if (!record(locks) || !Array.isArray(locks.rules)
    || locks.rules.some((rule) => !record(rule) || rule.enabled !== false)) {
    throw new Error("OBJECT_STORAGE_BUCKET must not have enabled R2 lock rules");
  }
  if (!record(sippy) || sippy.enabled !== false) {
    throw new Error("OBJECT_STORAGE_BUCKET must disable R2 on-demand migration");
  }

  const corsRules = record(cors) ? cors.rules : undefined;
  const corsRule = Array.isArray(corsRules) && corsRules.length === 1 ? corsRules[0] : null;
  const allowed = record(corsRule) && record(corsRule.allowed) ? corsRule.allowed : null;
  if (
    !allowed
    || !exactStrings(allowed.methods, ["PUT"])
    || !exactStrings(allowed.origins, [config.publicOrigin])
    || !exactStrings(allowed.headers, R2_UPLOAD_CORS_HEADERS, true)
    || !exactStrings(corsRule.exposeHeaders, ["ETag"], true)
    || corsRule.maxAgeSeconds !== 300
  ) {
    throw new Error("OBJECT_STORAGE_BUCKET must have the exact R2 upload CORS policy");
  }

  const lifecycleRules = record(lifecycle) ? lifecycle.rules : undefined;
  const incomingRules = Array.isArray(lifecycleRules)
    ? lifecycleRules.filter((rule) => record(rule) && record(rule.conditions) && rule.conditions.prefix === "incoming/")
    : [];
  const lifecycleRule = incomingRules.length === 1
    ? incomingRules[0]
    : null;
  const unsafeExtraRule = Array.isArray(lifecycleRules) && lifecycleRules.some((rule) =>
    rule !== lifecycleRule
    && (!record(rule)
      || rule.deleteObjectsTransition !== undefined
      || (rule.storageClassTransitions !== undefined
        && (!Array.isArray(rule.storageClassTransitions) || rule.storageClassTransitions.length > 0))));
  const conditions = record(lifecycleRule) && record(lifecycleRule.conditions)
    ? lifecycleRule.conditions
    : null;
  const expiration = record(lifecycleRule) && record(lifecycleRule.deleteObjectsTransition)
    && record(lifecycleRule.deleteObjectsTransition.condition)
    ? lifecycleRule.deleteObjectsTransition.condition
    : null;
  const abort = record(lifecycleRule) && record(lifecycleRule.abortMultipartUploadsTransition)
    && record(lifecycleRule.abortMultipartUploadsTransition.condition)
    ? lifecycleRule.abortMultipartUploadsTransition.condition
    : null;
  if (
    !record(lifecycleRule)
    || lifecycleRule.enabled !== true
    || conditions?.prefix !== "incoming/"
    || expiration?.type !== "Age"
    || expiration.maxAge !== 86_400
    || abort?.type !== "Age"
    || abort.maxAge !== 86_400
    || unsafeExtraRule
    || (lifecycleRule.storageClassTransitions !== undefined
      && (!Array.isArray(lifecycleRule.storageClassTransitions) || lifecycleRule.storageClassTransitions.length > 0))
  ) {
    throw new Error("OBJECT_STORAGE_BUCKET must expire and abort incoming R2 uploads after one day");
  }
}

export function createStorage(config: ApiConfig) {
  const common = {
    credentials: {
      accessKeyId: config.storageAccessKey,
      secretAccessKey: config.storageSecretKey,
    },
    forcePathStyle: true,
    region: config.storageRegion,
    ...(config.storageProvider === "r2" ? { requestChecksumCalculation: "WHEN_REQUIRED" as const } : {}),
  };
  const internal = new S3Client({ ...common, endpoint: config.storageInternalEndpoint });
  const publicSigner = new S3Client({ ...common, endpoint: config.storagePublicEndpoint });
  const requestOptions = () => ({ abortSignal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS) });

  const headObject = (objectKey: string) => internal.send(
    new HeadObjectCommand({ Bucket: config.storageBucket, Key: objectKey }),
    requestOptions(),
  );

  const markerEtag = async (sessionId: string, objectKey: string): Promise<string> => {
    const marker = await headObject(objectKey);
    if (
      marker.ContentLength !== 0
      || marker.ContentType !== R2_MARKER_CONTENT_TYPE
      || marker.Metadata?.["upload-session"] !== sessionId
      || !validEtag(marker.ETag)
    ) {
      throw new Error("R2 upload marker does not match the session");
    }
    return marker.ETag;
  };

  const createOrRecoverMarker = async (sessionId: string, objectKey: string): Promise<string> => {
    try {
      const created = await internal.send(new PutObjectCommand({
        Bucket: config.storageBucket,
        Key: objectKey,
        Body: new Uint8Array(0),
        ContentLength: 0,
        ContentType: R2_MARKER_CONTENT_TYPE,
        IfNoneMatch: "*",
        Metadata: { "upload-session": sessionId },
        StorageClass: R2_STORAGE_CLASS,
      }), requestOptions());
      if (!validEtag(created.ETag)) throw new Error("R2 upload marker ETag is missing");
      return created.ETag;
    } catch (error) {
      if (!preconditionFailed(error)) throw error;
      return markerEtag(sessionId, objectKey);
    }
  };

  const canonicalMatches = async (
    sessionId: string,
    objectKey: string,
    expectedSize: number,
    expectedEtag: string,
  ): Promise<boolean> => {
    try {
      const head = await headObject(objectKey);
      return head.ContentLength === expectedSize
        && head.ContentType === "application/pdf"
        && head.Metadata?.["upload-session"] === sessionId
        && head.ETag === expectedEtag;
    } catch {
      return false;
    }
  };

  return {
    async ensureBucket() {
      if (config.storageProvider === "r2") {
        await assertR2BucketConfiguration(config);
        await internal.send(
          new ListObjectsV2Command({ Bucket: config.storageBucket, MaxKeys: 1 }),
          requestOptions(),
        );
        return;
      }
      try {
        await internal.send(new HeadBucketCommand({ Bucket: config.storageBucket }), requestOptions());
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 404) throw error;
        if (config.appEnv === "production") {
          throw new Error("OBJECT_STORAGE_BUCKET must be provisioned before startup");
        }
        await internal.send(new CreateBucketCommand({ Bucket: config.storageBucket }), requestOptions());
      }
      if (config.appEnv === "production") {
        const [versioning, encryption, access] = await Promise.all([
          internal.send(new GetBucketVersioningCommand({ Bucket: config.storageBucket }), requestOptions()),
          internal.send(new GetBucketEncryptionCommand({ Bucket: config.storageBucket }), requestOptions()),
          internal.send(new GetPublicAccessBlockCommand({ Bucket: config.storageBucket }), requestOptions()),
        ]);
        if (versioning.Status !== undefined) {
          throw new Error("OBJECT_STORAGE_BUCKET must never have versioning enabled");
        }
        const kms = encryption.ServerSideEncryptionConfiguration?.Rules?.some((rule) =>
          rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === "aws:kms"
          && rule.ApplyServerSideEncryptionByDefault.KMSMasterKeyID === config.storageKmsKeyId);
        if (!kms) throw new Error("OBJECT_STORAGE_BUCKET must use the configured KMS key");
        const block = access.PublicAccessBlockConfiguration;
        if (!block?.BlockPublicAcls || !block.IgnorePublicAcls || !block.BlockPublicPolicy || !block.RestrictPublicBuckets) {
          throw new Error("OBJECT_STORAGE_BUCKET must block all public access");
        }
      }
      try {
        await internal.send(new PutBucketCorsCommand({
          Bucket: config.storageBucket,
          CORSConfiguration: {
            CORSRules: [{
              AllowedHeaders: ["*"],
              AllowedMethods: ["POST"],
              AllowedOrigins: [config.publicOrigin],
              ExposeHeaders: ["ETag"],
              MaxAgeSeconds: config.uploadTtlSeconds,
            }],
          },
        }), requestOptions());
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        // MinIO configura CORS a nivel servidor y responde 501 a PutBucketCors.
        if (status !== 501) throw error;
      }
      await internal.send(new PutBucketLifecycleConfigurationCommand({
        Bucket: config.storageBucket,
        LifecycleConfiguration: {
          Rules: [{
            ID: "expire-unconfirmed-uploads",
            Status: "Enabled",
            Filter: { Prefix: "incoming/" },
            Expiration: { Days: 1 },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          }],
        },
      }), requestOptions());
    },

    async authorizeUpload(
      sessionId: string,
      objectKey: string,
      expectedSize: number,
      expiresIn = config.uploadTtlSeconds,
      uploadMarkerEtag?: string,
    ) {
      if (config.storageProvider === "r2") {
        if (!validEtag(uploadMarkerEtag)) throw new Error("R2 upload marker ETag is required");
        const headers = {
          "Content-Length": String(expectedSize),
          "Content-Type": "application/pdf",
          "If-Match": uploadMarkerEtag,
          "x-amz-meta-upload-session": sessionId,
          "x-amz-storage-class": R2_STORAGE_CLASS,
        };
        const signedHeaders = new Set(Object.keys(headers).map((header) => header.toLowerCase()));
        const url = await getSignedUrl(publicSigner, new PutObjectCommand({
          Bucket: config.storageBucket,
          Key: objectKey,
          ContentLength: expectedSize,
          ContentType: headers["Content-Type"],
          IfMatch: uploadMarkerEtag,
          Metadata: { "upload-session": sessionId },
          StorageClass: R2_STORAGE_CLASS,
        }), {
          expiresIn,
          signableHeaders: signedHeaders,
          unhoistableHeaders: signedHeaders,
        });
        return { url, fields: {}, method: "PUT" as const, headers };
      }
      const encryptionFields = config.storageKmsKeyId ? {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": config.storageKmsKeyId,
      } : {};
      const signed = await createPresignedPost(publicSigner, {
        Bucket: config.storageBucket,
        Key: objectKey,
        Conditions: [
          ["content-length-range", expectedSize, expectedSize],
          ...Object.entries(encryptionFields).map(([key, value]) => ({ [key]: value })),
        ],
        Fields: {
          "Content-Type": "application/pdf",
          "x-amz-meta-upload-session": sessionId,
          ...encryptionFields,
        },
        Expires: expiresIn,
      });
      return { ...signed, method: "POST" as const, headers: {} };
    },

    async createUploadMarker(sessionId: string, objectKey: string) {
      if (config.storageProvider !== "r2") throw new Error("Upload markers are only supported by R2");
      return createOrRecoverMarker(sessionId, objectKey);
    },

    async authorizeDownload(objectKey: string) {
      const expiresIn = 120;
      const url = await getSignedUrl(publicSigner, new GetObjectCommand({
        Bucket: config.storageBucket,
        Key: objectKey,
        ResponseCacheControl: "no-store, private, max-age=0",
        ResponseContentDisposition: 'attachment; filename="salarivo-document.pdf"',
        ResponseContentType: "application/pdf",
      }), { expiresIn });
      return { url, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
    },

    async inspectUpload(sessionId: string, objectKey: string, expectedSize: number) {
      const head = await internal.send(
        new HeadObjectCommand({ Bucket: config.storageBucket, Key: objectKey }),
        requestOptions(),
      );
      if (
        head.ContentLength !== expectedSize ||
        head.ContentType !== "application/pdf" ||
        head.Metadata?.["upload-session"] !== sessionId ||
        !head.ETag
      ) {
        throw new Error("UPLOAD_OBJECT_MISMATCH");
      }
      return head.ETag;
    },

    canonicalKey(sessionId: string) {
      return `documents/${createHash("sha256").update(sessionId).digest("hex")}.pdf`;
    },

    async makeCanonical(
      sessionId: string,
      sourceKey: string,
      targetKey: string,
      sourceEtag: string,
      expectedSize: number,
    ) {
      if (config.storageProvider === "r2") {
        let destinationMarkerEtag: string;
        try {
          destinationMarkerEtag = await createOrRecoverMarker(sessionId, targetKey);
        } catch (error) {
          if (await canonicalMatches(sessionId, targetKey, expectedSize, sourceEtag)) return;
          throw error;
        }
        await waitForR2WriteWindow();
        const command = new CopyObjectCommand({
          Bucket: config.storageBucket,
          CopySource: copySource(config.storageBucket, sourceKey),
          CopySourceIfMatch: sourceEtag,
          Key: targetKey,
          MetadataDirective: "COPY",
          StorageClass: R2_STORAGE_CLASS,
        });
        addR2CopyDestinationIfMatch(command, destinationMarkerEtag);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await internal.send(command, requestOptions());
            return;
          } catch (error) {
            if (await canonicalMatches(sessionId, targetKey, expectedSize, sourceEtag)) return;
            if (attempt === 0 && retryableR2Copy(error)) {
              await waitForR2WriteWindow();
              continue;
            }
            throw error;
          }
        }
        throw new Error("R2 canonical copy exhausted its bounded retries");
      }
      await internal.send(new CopyObjectCommand({
        Bucket: config.storageBucket,
        CopySource: copySource(config.storageBucket, sourceKey),
        CopySourceIfMatch: sourceEtag,
        Key: targetKey,
        MetadataDirective: "COPY",
        ...(config.storageKmsKeyId ? {
          ServerSideEncryption: "aws:kms" as const,
          SSEKMSKeyId: config.storageKmsKeyId,
        } : {}),
      }), requestOptions());
    },

    async deleteObject(objectKey: string) {
      await internal.send(
        new DeleteObjectCommand({ Bucket: config.storageBucket, Key: objectKey }),
        requestOptions(),
      );
    },

    destroy() {
      internal.destroy();
      publicSigner.destroy();
    },
  };
}
