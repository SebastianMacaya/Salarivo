export const adminRoles = [
  "SUPER_ADMIN",
  "OPERATIONS",
  "SUPPORT",
  "SECURITY",
  "FINANCE",
  "READ_ONLY",
] as const;

export type AdminRole = typeof adminRoles[number];

export const adminPermissions = [
  "dashboard.read",
  "users.read_metadata",
  "users.read_contact",
  "users.status.update",
  "sessions.revoke",
  "documents.read_metadata",
  "documents.quarantine",
  "employers.read_metadata",
  "employers.manage",
  "processing.read",
  "processing.retry",
  "processing.cancel",
  "storage.read",
  "privacy.read",
  "security.read",
  "audit.read",
  "settings.read",
  "system.health.read",
  "roles.manage",
] as const;

export type AdminPermission = typeof adminPermissions[number];

const readonlyPermissions = [
  "dashboard.read",
  "users.read_metadata",
  "documents.read_metadata",
  "employers.read_metadata",
  "processing.read",
  "storage.read",
  "privacy.read",
  "audit.read",
  "settings.read",
  "system.health.read",
] satisfies AdminPermission[];

const permissionsByRole: Record<AdminRole, readonly AdminPermission[]> = {
  READ_ONLY: readonlyPermissions,
  OPERATIONS: [
    ...readonlyPermissions,
    "documents.quarantine",
    "processing.retry",
    "processing.cancel",
  ],
  SUPPORT: [
    "dashboard.read",
    "users.read_metadata",
    "users.read_contact",
    "documents.read_metadata",
    "employers.read_metadata",
    "processing.read",
    "privacy.read",
    "audit.read",
    "system.health.read",
  ],
  SECURITY: [
    "dashboard.read",
    "users.read_metadata",
    "users.read_contact",
    "users.status.update",
    "sessions.revoke",
    "documents.read_metadata",
    "documents.quarantine",
    "security.read",
    "audit.read",
    "system.health.read",
  ],
  FINANCE: [
    "dashboard.read",
    "storage.read",
    "settings.read",
    "system.health.read",
  ],
  SUPER_ADMIN: adminPermissions,
};

export function isAdminRole(value: unknown): value is AdminRole {
  return typeof value === "string" && (adminRoles as readonly string[]).includes(value);
}

export function permissionsForAdminRole(role: unknown): readonly AdminPermission[] {
  return isAdminRole(role) ? permissionsByRole[role] : [];
}

export function hasAdminPermission(role: unknown, permission: AdminPermission): boolean {
  return permissionsForAdminRole(role).includes(permission);
}
