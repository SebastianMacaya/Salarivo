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

export function createStorage(config: ApiConfig) {
  const common = {
    credentials: {
      accessKeyId: config.storageAccessKey,
      secretAccessKey: config.storageSecretKey,
    },
    forcePathStyle: true,
    region: config.storageRegion,
  };
  const internal = new S3Client({ ...common, endpoint: config.storageInternalEndpoint });
  const publicSigner = new S3Client({ ...common, endpoint: config.storagePublicEndpoint });
  const requestOptions = () => ({ abortSignal: AbortSignal.timeout(STORAGE_REQUEST_TIMEOUT_MS) });

  return {
    async ensureBucket() {
      try {
        await internal.send(new HeadBucketCommand({ Bucket: config.storageBucket }), requestOptions());
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 404) throw error;
        if (config.appEnv === "production") throw new Error("OBJECT_STORAGE_BUCKET must be provisioned before production startup");
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

    async authorizeUpload(sessionId: string, objectKey: string, expectedSize: number) {
      const encryptionFields = config.storageKmsKeyId ? {
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": config.storageKmsKeyId,
      } : {};
      return createPresignedPost(publicSigner, {
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
        Expires: config.uploadTtlSeconds,
      });
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

    async makeCanonical(sourceKey: string, targetKey: string, sourceEtag: string) {
      await internal.send(new CopyObjectCommand({
        Bucket: config.storageBucket,
        CopySource: `${config.storageBucket}/${sourceKey}`,
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
