import assert from "node:assert/strict";
import test from "node:test";
import {
  adminPermissions,
  adminRoles,
  hasAdminPermission,
  permissionsForAdminRole,
} from "../src/admin-rbac.ts";

test("admin RBAC is fixed, explicit and deny-by-default", () => {
  assert.deepEqual(adminRoles, ["SUPER_ADMIN", "OPERATIONS", "SUPPORT", "SECURITY", "FINANCE", "READ_ONLY"]);
  assert.equal(new Set(adminPermissions).size, adminPermissions.length);
  assert.deepEqual(permissionsForAdminRole("UNKNOWN"), []);
  assert.equal(hasAdminPermission("READ_ONLY", "roles.manage"), false);
  assert.equal(hasAdminPermission("OPERATIONS", "processing.retry"), true);
  assert.equal(hasAdminPermission("SUPPORT", "users.read_contact"), true);
  assert.equal(hasAdminPermission("SECURITY", "users.status.update"), true);
  assert.equal(hasAdminPermission("FINANCE", "users.read_metadata"), false);
  assert.deepEqual(permissionsForAdminRole("SUPER_ADMIN"), adminPermissions);
});
