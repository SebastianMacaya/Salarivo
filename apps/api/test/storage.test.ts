import assert from "node:assert/strict";
import test from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { loadConfig } from "../src/config.ts";
import { assertR2BucketConfiguration, copySource, createStorage } from "../src/storage.ts";

const accountId = "0123456789abcdef0123456789abcdef";

function r2Config() {
  return loadConfig({
    APP_ENV: "test",
    PUBLIC_ORIGIN: "https://www.example.test",
    OBJECT_STORAGE_PROVIDER: "r2",
    OBJECT_STORAGE_ACCESS_KEY: "access-key",
    OBJECT_STORAGE_SECRET_KEY: "secret-key",
    OBJECT_STORAGE_BUCKET: "documents",
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_R2_API_TOKEN: "read-only-token",
  });
}

function validR2Results(): Record<string, unknown> {
  const bucketPath = `/client/v4/accounts/${accountId}/r2/buckets/documents`;
  return {
    [bucketPath]: { name: "documents", storage_class: "Standard" },
    [`${bucketPath}/cors`]: {
      rules: [{
        allowed: {
          methods: ["PUT"],
          origins: ["https://www.example.test"],
          headers: ["Content-Type", "If-Match", "x-amz-meta-upload-session", "x-amz-storage-class"],
        },
        exposeHeaders: ["ETag"],
        maxAgeSeconds: 300,
      }],
    },
    [`${bucketPath}/domains/managed`]: { enabled: false },
    [`${bucketPath}/domains/custom`]: { domains: [{ domain: "old.example.test", enabled: false }] },
    [`${bucketPath}/lock`]: { rules: [] },
    [`${bucketPath}/sippy`]: { enabled: false },
    [`${bucketPath}/lifecycle`]: {
      rules: [{
        id: "Default Multipart Abort Rule",
        enabled: true,
        conditions: { prefix: "" },
        abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604_800 } },
      }, {
        id: "expire-unconfirmed-uploads",
        enabled: true,
        conditions: { prefix: "incoming/" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86_400 } },
        abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 86_400 } },
      }],
    },
  };
}

function cloudflareFetch(results: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    calls.push(url.pathname);
    assert.equal(init?.method ?? "GET", "GET");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer read-only-token");
    assert.ok(url.pathname in results, `unexpected Cloudflare request: ${url.pathname}`);
    return new Response(JSON.stringify({ success: true, result: results[url.pathname] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

test("R2 startup assertions are read-only and fail closed on unsafe bucket settings", async () => {
  const config = r2Config();
  const calls: string[] = [];
  await assertR2BucketConfiguration(config, cloudflareFetch(validR2Results(), calls));
  assert.equal(calls.length, 7);

  const cases: Array<[string, (results: Record<string, unknown>) => void, RegExp]> = [
    ["storage class", (results) => {
      (results[`/client/v4/accounts/${accountId}/r2/buckets/documents`] as Record<string, unknown>).storage_class = "InfrequentAccess";
    }, /Standard/],
    ["r2.dev", (results) => {
      (results[`/client/v4/accounts/${accountId}/r2/buckets/documents/domains/managed`] as Record<string, unknown>).enabled = true;
    }, /r2\.dev/],
    ["custom domain", (results) => {
      (results[`/client/v4/accounts/${accountId}/r2/buckets/documents/domains/custom`] as Record<string, unknown>).domains = [{ enabled: true }];
    }, /custom domain/],
    ["bucket lock", (results) => {
      (results[`/client/v4/accounts/${accountId}/r2/buckets/documents/lock`] as { rules: unknown[] }).rules.push({ enabled: true });
    }, /lock rules/],
    ["on-demand migration", (results) => {
      (results[`/client/v4/accounts/${accountId}/r2/buckets/documents/sippy`] as { enabled: boolean }).enabled = true;
    }, /on-demand migration/],
    ["CORS", (results) => {
      const cors = results[`/client/v4/accounts/${accountId}/r2/buckets/documents/cors`] as { rules: Array<{ allowed: { origins: string[] } }> };
      cors.rules[0]!.allowed.origins.push("https://public.example.test");
    }, /CORS/],
    ["CORS exposed headers", (results) => {
      const cors = results[`/client/v4/accounts/${accountId}/r2/buckets/documents/cors`] as { rules: Array<{ exposeHeaders: string[] }> };
      cors.rules[0]!.exposeHeaders = [];
    }, /CORS/],
    ["CORS max age", (results) => {
      const cors = results[`/client/v4/accounts/${accountId}/r2/buckets/documents/cors`] as { rules: Array<{ maxAgeSeconds: number }> };
      cors.rules[0]!.maxAgeSeconds = 301;
    }, /CORS/],
    ["lifecycle", (results) => {
      const lifecycle = results[`/client/v4/accounts/${accountId}/r2/buckets/documents/lifecycle`] as {
        rules: Array<{ deleteObjectsTransition: { condition: { maxAge: number } } }>;
      };
      lifecycle.rules[1]!.deleteObjectsTransition.condition.maxAge = 86_401;
    }, /after one day/],
    ["storage transition", (results) => {
      const lifecycle = results[`/client/v4/accounts/${accountId}/r2/buckets/documents/lifecycle`] as {
        rules: Array<{ storageClassTransitions?: unknown[] }>;
      };
      lifecycle.rules[1]!.storageClassTransitions = [{}];
    }, /after one day/],
    ["global delete rule", (results) => {
      const lifecycle = results[`/client/v4/accounts/${accountId}/r2/buckets/documents/lifecycle`] as { rules: unknown[] };
      lifecycle.rules.push({
        enabled: true,
        conditions: { prefix: "" },
        deleteObjectsTransition: { condition: { type: "Age", maxAge: 86_400 } },
      });
    }, /after one day/],
  ];
  for (const [name, change, error] of cases) {
    const results = validR2Results();
    change(results);
    await assert.rejects(
      assertR2BucketConfiguration(config, cloudflareFetch(results)),
      error,
      name,
    );
  }
});

test("copy source is an absolute, segment-encoded path", () => {
  assert.equal(copySource("documents", "incoming/object name?.pdf"), "/documents/incoming/object%20name%3F.pdf");
});

test("R2 authorizes a size-, type- and metadata-bound PUT while AWS keeps POST", async () => {
  const r2 = createStorage(r2Config());
  try {
    const upload = await r2.authorizeUpload("session-id", "incoming/object.pdf", 12_345, 300, '"marker-etag"');
    assert.equal(upload.method, "PUT");
    assert.deepEqual(upload.fields, {});
    assert.deepEqual(upload.headers, {
      "Content-Length": "12345",
      "Content-Type": "application/pdf",
      "If-Match": '"marker-etag"',
      "x-amz-meta-upload-session": "session-id",
      "x-amz-storage-class": "STANDARD",
    });
    const signedHeaders = new URL(upload.url).searchParams.get("X-Amz-SignedHeaders")?.split(";");
    assert.deepEqual(signedHeaders, [
      "content-length",
      "content-type",
      "host",
      "if-match",
      "x-amz-meta-upload-session",
      "x-amz-storage-class",
    ]);
    const shorter = await r2.authorizeUpload("session-id", "incoming/object.pdf", 12_345, 42, '"marker-etag"');
    assert.equal(new URL(shorter.url).searchParams.get("X-Amz-Expires"), "42");
    await assert.rejects(
      r2.authorizeUpload("session-id", "incoming/object.pdf", 12_345),
      /marker ETag is required/,
    );
  } finally {
    r2.destroy();
  }

  const aws = createStorage(loadConfig({ APP_ENV: "test" }));
  try {
    const upload = await aws.authorizeUpload("session-id", "incoming/object.pdf", 12_345);
    assert.equal(upload.method, "POST");
    assert.equal(upload.headers && Object.keys(upload.headers).length, 0);
    assert.equal(upload.fields["Content-Type"], "application/pdf");
  } finally {
    aws.destroy();
  }
});

test("R2 markers are recovered atomically and make canonical copy races idempotent", async () => {
  type StoredHead = {
    ContentLength: number;
    ContentType: string;
    ETag: string;
    Metadata: Record<string, string>;
  };
  type TestCommand = {
    constructor: { name: string };
    input: Record<string, unknown>;
    middlewareStack: {
      resolve: (handler: (args: unknown) => Promise<unknown>, context: unknown) => (args: unknown) => Promise<unknown>;
    };
  };
  const clientPrototype = S3Client.prototype as unknown as {
    send: (command: TestCommand) => Promise<Record<string, unknown>>;
  };
  const originalSend = clientPrototype.send;
  const objects = new Map<string, StoredHead>();
  let copyDestinationIfMatch: string | undefined;
  clientPrototype.send = async (command) => {
    const key = String(command.input.Key);
    if (command.constructor.name === "PutObjectCommand") {
      assert.equal(command.input.IfNoneMatch, "*");
      assert.equal(command.input.ContentLength, 0);
      assert.equal(command.input.ContentType, "application/octet-stream");
      assert.equal(command.input.StorageClass, "STANDARD");
      assert.deepEqual(command.input.Metadata, { "upload-session": "session-id" });
      await Promise.resolve();
      if (objects.has(key)) {
        throw Object.assign(new Error("precondition"), { $metadata: { httpStatusCode: 412 } });
      }
      const marker = {
        ContentLength: 0,
        ContentType: "application/octet-stream",
        ETag: '"marker-etag"',
        Metadata: { "upload-session": "session-id" },
      };
      objects.set(key, marker);
      return { ETag: marker.ETag };
    }
    if (command.constructor.name === "HeadObjectCommand") {
      const stored = objects.get(key);
      if (!stored) throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
      return stored;
    }
    if (command.constructor.name === "CopyObjectCommand") {
      assert.equal(command.input.CopySourceIfMatch, '"source-etag"');
      assert.equal(command.input.StorageClass, "STANDARD");
      const result = await command.middlewareStack.resolve(
        async (args) => ({
          output: { $metadata: {}, headers: (args as { request: { headers: Record<string, string> } }).request.headers },
          response: {},
        }),
        {},
      )({ input: command.input, request: { headers: {} } }) as {
        output: { headers: Record<string, string> };
      };
      copyDestinationIfMatch = result.output.headers["cf-copy-destination-if-match"];
      // Another copy commits first. This request must fail its destination condition,
      // then the caller verifies that the winning object is exactly the expected one.
      objects.set(key, {
        ContentLength: 12_345,
        ContentType: "application/pdf",
        ETag: '"source-etag"',
        Metadata: { "upload-session": "session-id" },
      });
      throw Object.assign(new Error("precondition"), { $metadata: { httpStatusCode: 412 } });
    }
    throw new Error(`unexpected command: ${command.constructor.name}`);
  };

  const r2 = createStorage(r2Config());
  try {
    const recovered = await Promise.all([
      r2.createUploadMarker("session-id", "incoming/object.pdf"),
      r2.createUploadMarker("session-id", "incoming/object.pdf"),
    ]);
    assert.deepEqual(recovered, ['"marker-etag"', '"marker-etag"']);

    objects.set("incoming/object.pdf", {
      ContentLength: 12_345,
      ContentType: "application/pdf",
      ETag: '"source-etag"',
      Metadata: { "upload-session": "session-id" },
    });
    await assert.rejects(
      r2.createUploadMarker("session-id", "incoming/object.pdf"),
      /does not match the session/,
    );

    await r2.makeCanonical(
      "session-id",
      "incoming/object.pdf",
      "documents/object.pdf",
      '"source-etag"',
      12_345,
    );
    assert.equal(copyDestinationIfMatch, '"marker-etag"');
  } finally {
    r2.destroy();
    clientPrototype.send = originalSend;
  }
});

test("R2 canonical copy retries a throttled write after the same-key window", async () => {
  type TestCommand = {
    constructor: { name: string };
    input: Record<string, unknown>;
    middlewareStack: {
      resolve: (handler: (args: unknown) => Promise<unknown>, context: unknown) => (args: unknown) => Promise<unknown>;
    };
  };
  const clientPrototype = S3Client.prototype as unknown as {
    send: (command: TestCommand) => Promise<Record<string, unknown>>;
  };
  const originalSend = clientPrototype.send;
  const copyConditions: string[] = [];
  let copyCalls = 0;
  clientPrototype.send = async (command) => {
    if (command.constructor.name === "PutObjectCommand") return { ETag: '"marker-etag"' };
    if (command.constructor.name === "HeadObjectCommand") {
      return {
        ContentLength: 0,
        ContentType: "application/octet-stream",
        ETag: '"marker-etag"',
        Metadata: { "upload-session": "session-id" },
      };
    }
    if (command.constructor.name === "CopyObjectCommand") {
      copyCalls += 1;
      const result = await command.middlewareStack.resolve(
        async (args) => ({
          output: { $metadata: {}, headers: (args as { request: { headers: Record<string, string> } }).request.headers },
          response: {},
        }),
        {},
      )({ input: command.input, request: { headers: {} } }) as {
        output: { headers: Record<string, string> };
      };
      copyConditions.push(result.output.headers["cf-copy-destination-if-match"]!);
      if (copyCalls === 1) {
        throw Object.assign(new Error("throttled"), { $metadata: { httpStatusCode: 429 } });
      }
      return {};
    }
    throw new Error(`unexpected command: ${command.constructor.name}`);
  };

  const r2 = createStorage(r2Config());
  const startedAt = Date.now();
  try {
    await r2.makeCanonical(
      "session-id",
      "incoming/object.pdf",
      "documents/object.pdf",
      '"source-etag"',
      12_345,
    );
    assert.equal(copyCalls, 2);
    assert.deepEqual(copyConditions, ['"marker-etag"', '"marker-etag"']);
    assert.ok(Date.now() - startedAt >= 2_000);
  } finally {
    r2.destroy();
    clientPrototype.send = originalSend;
  }
});
