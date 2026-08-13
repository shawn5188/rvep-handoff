import { Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok } from "@/lib/api-response";
import { AppError, Conflict, UnprocessableEntity } from "@/lib/errors";
import { withAdmin } from "@/middleware/require-admin";
import { logAudit } from "@/lib/audit";
import { putUserPermissionsSchema } from "@/lib/admin-permission-schemas";
import { findUserOr404 } from "@/lib/admin-user-serializer";
import {
  computeDiff,
  diffAuditPayload,
  getUserPermissionsPayload,
  PermissionState,
} from "@/lib/admin-permission-serializer";

/**
 * c15 P5 — per-user permission matrix admin resource.
 *
 * GET /api/v1/admin/permissions?userId=X
 *   The user's permission on every non-archived vehicle (missing = none) +
 *   availableVehicles (non-archived vehicles without a permission yet, for
 *   the admin "add" flow).
 *
 * PUT /api/v1/admin/permissions
 *   Full replace of the user's permissions (whole array, atomic transaction).
 *   Red lines:
 *     - admins cannot edit their own permissions (400 cannot_edit_own_permissions)
 *     - per-vehicle ADMIN role only for users whose global role is ADMIN —
 *       promote via PATCH /admin/users/:id first (400 cannot_grant_admin_to_non_admin)
 *   Permissions on archived vehicles are out of scope: GET hides them, PUT
 *   rejects their ids and leaves existing rows untouched.
 */

export const GET = withAdmin(async (request) => {
  const userId = new URL(request.url).searchParams.get("userId");
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new UnprocessableEntity("validation_error", {
      issues: [{ path: "userId", message: "userId query param must be a uuid" }],
    });
  }
  const user = await findUserOr404(userId);
  return ok(await getUserPermissionsPayload(user));
});

export const PUT = withAdmin(async (request, auth) => {
  const parsed = putUserPermissionsSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    throw new UnprocessableEntity("validation_error", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const input = parsed.data;

  // Red line: an admin editing their own permissions could self-lock or
  // self-escalate — always requires a second admin.
  if (input.userId === auth.userId) {
    throw new AppError("cannot_edit_own_permissions", 400);
  }

  const user = await findUserOr404(input.userId);
  if (user.archivedAt) {
    throw new Conflict("user_archived", {
      archivedAt: user.archivedAt.toISOString(),
    });
  }

  // Red line: per-vehicle ADMIN for a non-ADMIN user is a role change in
  // disguise — that goes through PATCH /admin/users/:id (dedicated audit).
  if (
    user.role !== Role.ADMIN &&
    input.permissions.some((p) => p.role === Role.ADMIN)
  ) {
    throw new AppError("cannot_grant_admin_to_non_admin", 400, {
      userRole: user.role,
    });
  }

  // Every referenced vehicle must exist and be non-archived.
  const referencedIds = input.permissions.map((p) => p.vehicleId);
  const vehicles = await prisma.vehicle.findMany({
    where: { id: { in: referencedIds }, archivedAt: null },
    select: { id: true, vehicleId: true },
  });
  const vehicleById = new Map(vehicles.map((v) => [v.id, v.vehicleId]));
  const unknown = referencedIds.filter((id) => !vehicleById.has(id));
  if (unknown.length > 0) {
    throw new UnprocessableEntity("unknown_vehicle", { vehicleIds: unknown });
  }

  // Current state, restricted to non-archived vehicles (see header comment).
  const existing = await prisma.vehiclePermission.findMany({
    where: { userId: user.id, vehicle: { archivedAt: null } },
    select: {
      vehicleId: true,
      role: true,
      priorityOverride: true,
      vehicle: { select: { vehicleId: true } },
    },
  });
  for (const p of existing) vehicleById.set(p.vehicleId, p.vehicle.vehicleId);

  const oldState: PermissionState[] = existing.map((p) => ({
    vehicleId: p.vehicleId,
    role: p.role,
    priorityOverride: p.priorityOverride,
  }));
  const newState: PermissionState[] = input.permissions.map((p) => ({
    vehicleId: p.vehicleId,
    role: p.role,
    priorityOverride: p.priorityOverride ?? null,
  }));

  const diff = computeDiff(oldState, newState);
  const isNoop =
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0;

  if (!isNoop) {
    // Atomic full replace — (userId, vehicleId) is the unique key, so the
    // delete/create/update trio below covers every diff bucket exactly once.
    await prisma.$transaction([
      ...(diff.removed.length > 0
        ? [
            prisma.vehiclePermission.deleteMany({
              where: {
                userId: user.id,
                vehicleId: { in: diff.removed.map((p) => p.vehicleId) },
              },
            }),
          ]
        : []),
      ...(diff.added.length > 0
        ? [
            prisma.vehiclePermission.createMany({
              data: diff.added.map((p) => ({
                userId: user.id,
                vehicleId: p.vehicleId,
                role: p.role,
                priorityOverride: p.priorityOverride,
                grantedBy: auth.userId,
              })),
            }),
          ]
        : []),
      ...diff.changed.map((c) =>
        prisma.vehiclePermission.update({
          where: {
            userId_vehicleId: { userId: user.id, vehicleId: c.vehicleId },
          },
          data: {
            role: c.to.role,
            priorityOverride: c.to.priorityOverride,
            grantedBy: auth.userId,
          },
        }),
      ),
    ]);

    await logAudit({
      actorId: auth.userId,
      eventName: "user_permissions_updated",
      targetType: "User",
      targetId: user.id,
      payload: {
        email: user.email,
        ...diffAuditPayload(diff, vehicleById),
      },
    });
  }

  return ok(await getUserPermissionsPayload(user));
});
