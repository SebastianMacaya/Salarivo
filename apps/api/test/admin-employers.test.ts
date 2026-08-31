import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "@salarivo/database";
import type { FastifyRequest } from "fastify";

class TestApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

test("employer management takes the shared mutation lock before session and actor rows", async () => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
  const { lockEmployerManagement } = await import("../src/admin-routes.ts");
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("FROM sessions")) return { rowCount: 1, rows: [{ id: "session-1" }] };
      if (sql.includes("FROM users")) {
        return {
          rowCount: 1,
          rows: [{ role: "ADMIN", admin_role: "SUPER_ADMIN", status: "ACTIVE", deleted_at: null }],
        };
      }
      return { rowCount: 1, rows: [{}] };
    },
  } as unknown as PoolClient;
  const request = {
    authSessionHash: "session-hash",
    authUser: { id: "actor-1" },
  } as unknown as FastifyRequest;

  assert.equal(await lockEmployerManagement(client, request, TestApiError), "SUPER_ADMIN");
  assert.match(statements[0]!, /pg_advisory_xact_lock\(713, 12013\)/);
  assert.match(statements[1]!, /FROM sessions/);
  assert.match(statements[2]!, /FROM users/);
});
