import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "@salarivo/database";
import {
  lockR2UploadCapacity,
  R2_GLOBAL_STORAGE_CAP_BYTES,
  R2_TOMBSTONE_FALLBACK_BYTES,
} from "../src/r2-capacity.ts";

test("R2 capacity uses the fixed historical file ceiling for orphaned tombstones", async () => {
  const queries: Array<{ parameters?: unknown[]; text: string }> = [];
  const client = {
    async query(text: string, parameters?: unknown[]) {
      queries.push(parameters === undefined ? { text } : { text, parameters });
      return queries.length === 1
        ? { rows: [] }
        : { rows: [{ physical_bytes: (R2_GLOBAL_STORAGE_CAP_BYTES - 2n).toString() }] };
    },
  } as unknown as PoolClient;

  assert.equal(await lockR2UploadCapacity(client, 1), true);
  assert.equal(R2_TOMBSTONE_FALLBACK_BYTES, 104_857_600n);
  assert.deepEqual(queries[1]?.parameters, ["104857600"]);
  assert.match(queries[1]?.text ?? "", /COALESCE\(document\.size_bytes, session\.expected_size_bytes, \$1::bigint\)/);
  assert.match(
    queries[1]?.text ?? "",
    /WHEN session\.status IN \('OPEN', 'EXPIRED'\)[\s\S]*THEN session\.expected_size_bytes \* 2/,
  );
});
