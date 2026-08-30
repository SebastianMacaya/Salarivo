import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { createHash } from "node:crypto";
import type { ApiConfig } from "./config.ts";

export type Storage = ReturnType<typeof createStorage>;

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

  return {
    async ensureBucket() {
      try {
        await internal.send(new HeadBucketCommand({ Bucket: config.storageBucket }));
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status !== 404) throw error;
        await internal.send(new CreateBucketCommand({ Bucket: config.storageBucket }));
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
        }));
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
      }));
    },

    async authorizeUpload(sessionId: string, objectKey: string, expectedSize: number) {
      return createPresignedPost(publicSigner, {
        Bucket: config.storageBucket,
        Key: objectKey,
        Conditions: [["content-length-range", expectedSize, expectedSize]],
        Fields: {
          "Content-Type": "application/pdf",
          "x-amz-meta-upload-session": sessionId,
        },
        Expires: config.uploadTtlSeconds,
      });
    },

    async inspectUpload(sessionId: string, objectKey: string, expectedSize: number) {
      const head = await internal.send(new HeadObjectCommand({ Bucket: config.storageBucket, Key: objectKey }));
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
      }));
    },

    async deleteObject(objectKey: string) {
      await internal.send(new DeleteObjectCommand({ Bucket: config.storageBucket, Key: objectKey }));
    },

    destroy() {
      internal.destroy();
      publicSigner.destroy();
    },
  };
}
