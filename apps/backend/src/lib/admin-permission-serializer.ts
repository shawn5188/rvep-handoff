import { Role, User, Vehicle, VehiclePermission } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * c15 P5 — wire shape + diff helpers for the admin permission-matrix API.
 *
 * Naming (deliberate, do not "simplify"):
 *   vehicleId          = Vehicle.id (internal UUID) — matches the PUT input
 *                        and the VehiclePermission FK.
 *   vehicleExternalId  = Vehicle.vehicleId (machine id, e.g. "amr-01") —
 *                        display / audit readability only.
 *
 * Archived-vehicle semantics: permissions attached to archived vehicles are
 * invisible to GET and untouched by PUT (full-replace operates on the
 * non-archived universe only), so a GET → PUT round-trip never silently
 * deletes them.
 */

type PermissionWithVehicle = VehiclePermission & {
  vehicle: Vehicle;
  granter: { email: string } | null;
};

export function serializePermissionEntry(p: PermissionWithVehicle) {
  return {
    vehicleId: p.vehicle.id,
    vehicleExternalId: p.vehicle.vehicleId,
    vehicleDisplayName: p.vehicle.displayName,
    vehicleStatus: p.vehicle.status,
    role: p.role,
    priorityOverride: p.priorityOverride,
    grantedBy: p.grantedBy,
    grantedByEmail: p.granter?.email ?? null,
    updatedAt: p.updatedAt.toISOString(),
  };
}

/**
 * Shared response body for GET /admin/permissions?userId=X and the PUT echo:
 * the user's permissions on every non-archived vehicle + the non-archived
 * vehicles the user has no permission for yet (for the "add" flow).
 */
export async function getUserPermissionsPayload(user: User) {
  const [permissions, availableVehicles] = await Promise.all([
    prisma.vehiclePermission.findMany({
      where: { userId: user.id, vehicle: { archivedAt: null } },
      include: { vehicle: true, granter: { select: { email: true } } },
      orderBy: { vehicle: { vehicleId: "asc" } },
    }),
    prisma.vehicle.findMany({
      where: {
        archivedAt: null,
        vehiclePermissions: { none: { userId: user.id } },
      },
      orderBy: { vehicleId: "asc" },
    }),
  ]);

  return {
    userId: user.id,
    userEmail: user.email,
    userDisplayName: user.displayName,
    userRole: user.role,
    permissions: permissions.map(serializePermissionEntry),
    availableVehicles: availableVehicles.map((v) => ({
      vehicleId: v.id,
      vehicleExternalId: v.vehicleId,
      displayName: v.displayName,
      vehicleType: v.vehicleType,
      status: v.status,
    })),
  };
}

export type UserPermissionsPayload = Awaited<
  ReturnType<typeof getUserPermissionsPayload>
>;

// ---------------------------------------------------------------------------
// Diff — drives both the transaction plan and the audit payload
// ---------------------------------------------------------------------------

export interface PermissionState {
  vehicleId: string; // Vehicle.id (internal UUID)
  role: Role;
  priorityOverride: number | null;
}

export interface PermissionDiff {
  added: PermissionState[];
  removed: PermissionState[];
  changed: Array<{
    vehicleId: string;
    from: { role: Role; priorityOverride: number | null };
    to: { role: Role; priorityOverride: number | null };
  }>;
}

export function computeDiff(
  oldPerms: PermissionState[],
  newPerms: PermissionState[],
): PermissionDiff {
  const oldByVehicle = new Map(oldPerms.map((p) => [p.vehicleId, p]));
  const newByVehicle = new Map(newPerms.map((p) => [p.vehicleId, p]));

  const diff: PermissionDiff = { added: [], removed: [], changed: [] };

  for (const next of newPerms) {
    const prev = oldByVehicle.get(next.vehicleId);
    if (!prev) {
      diff.added.push(next);
    } else if (
      prev.role !== next.role ||
      prev.priorityOverride !== next.priorityOverride
    ) {
      diff.changed.push({
        vehicleId: next.vehicleId,
        from: { role: prev.role, priorityOverride: prev.priorityOverride },
        to: { role: next.role, priorityOverride: next.priorityOverride },
      });
    }
  }
  for (const prev of oldPerms) {
    if (!newByVehicle.has(prev.vehicleId)) diff.removed.push(prev);
  }
  return diff;
}

/**
 * Audit payload for `user_permissions_updated`: per-vehicle entries would be
 * too noisy, so we log counts + up to 3 examples per bucket. Examples use the
 * external vehicle id for human readability in the audit viewer.
 */
export function diffAuditPayload(
  diff: PermissionDiff,
  externalIdByVehicleId: Map<string, string>,
): Record<string, unknown> {
  const ext = (id: string) => externalIdByVehicleId.get(id) ?? id;
  return {
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
    examples: {
      added: diff.added.slice(0, 3).map((p) => ({
        vehicleId: ext(p.vehicleId),
        role: p.role,
        priorityOverride: p.priorityOverride,
      })),
      removed: diff.removed.slice(0, 3).map((p) => ({
        vehicleId: ext(p.vehicleId),
        role: p.role,
      })),
      changed: diff.changed.slice(0, 3).map((c) => ({
        vehicleId: ext(c.vehicleId),
        from: c.from,
        to: c.to,
      })),
    },
  };
}
