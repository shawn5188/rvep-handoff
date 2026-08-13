import { prisma } from "@/lib/db";
import { ok } from "@/lib/api-response";
import { UnprocessableEntity } from "@/lib/errors";
import { withAdmin } from "@/middleware/require-admin";
import { matrixQuerySchema } from "@/lib/admin-permission-schemas";

/**
 * c15 P5 — GET /api/v1/admin/permissions/matrix[?limit=50&offset=0]
 *
 * Full users × vehicles grid for the admin matrix view. Archived users and
 * archived vehicles are excluded. Pagination runs on the user axis (rows);
 * the vehicle axis (columns) is returned whole — fleets are small compared
 * to user counts, revisit when multi-tenant lands.
 */

export const GET = withAdmin(async (request) => {
  const params = new URL(request.url).searchParams;
  const parsed = matrixQuerySchema.safeParse({
    limit: params.get("limit") ?? undefined,
    offset: params.get("offset") ?? undefined,
  });
  if (!parsed.success) {
    throw new UnprocessableEntity("validation_error", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const { limit, offset } = parsed.data;

  const [users, totalUsers, vehicles] = await Promise.all([
    prisma.user.findMany({
      where: { archivedAt: null },
      orderBy: { email: "asc" },
      skip: offset,
      take: limit,
      select: { id: true, email: true, displayName: true, role: true },
    }),
    prisma.user.count({ where: { archivedAt: null } }),
    prisma.vehicle.findMany({
      where: { archivedAt: null },
      orderBy: { vehicleId: "asc" },
      select: {
        id: true,
        vehicleId: true,
        displayName: true,
        vehicleType: true,
        status: true,
      },
    }),
  ]);

  const permissions = await prisma.vehiclePermission.findMany({
    where: {
      userId: { in: users.map((u) => u.id) },
      vehicleId: { in: vehicles.map((v) => v.id) },
    },
    select: {
      userId: true,
      vehicleId: true,
      role: true,
      priorityOverride: true,
      grantedBy: true,
    },
  });

  return ok({
    users: users.map((u) => ({
      userId: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
    })),
    vehicles: vehicles.map((v) => ({
      vehicleId: v.id, // internal UUID — matches permissions[].vehicleId + PUT input
      vehicleExternalId: v.vehicleId,
      displayName: v.displayName,
      vehicleType: v.vehicleType,
      status: v.status,
    })),
    permissions,
    totalUsers,
    limit,
    offset,
  });
});
