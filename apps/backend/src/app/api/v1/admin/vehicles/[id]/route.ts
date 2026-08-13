import { Prisma, Vehicle } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok } from "@/lib/api-response";
import { Conflict, UnprocessableEntity } from "@/lib/errors";
import { withAdmin } from "@/middleware/require-admin";
import { logAudit } from "@/lib/audit";
import { updateVehicleSchema } from "@/lib/admin-vehicle-schemas";
import {
  findVehicleOr404,
  serializeVehicle,
} from "@/lib/admin-vehicle-serializer";
import { findAdapterType } from "@/lib/adapter-registry";

/**
 * c15 P3 — single vehicle admin resource. `[id]` = external vehicleId.
 *
 * GET    — full detail + latest 5 leases / 5 sessions usage snapshot.
 * PATCH  — partial update (vehicleId / createdAt / createdBy immutable);
 *          audit payload carries a field-level diff.
 * DELETE — soft delete (archivedAt = now); sessions + audit trail retained.
 */

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAdmin<Ctx>(async (_request, _auth, context) => {
  const { id } = await context.params;
  const vehicle = await findVehicleOr404(id);

  const [leases, sessions, creator] = await Promise.all([
    prisma.controlLease.findMany({
      where: { vehicleId: vehicle.id },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { operator: { select: { email: true } } },
    }),
    prisma.session.findMany({
      where: { vehicleId: vehicle.id },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { user: { select: { email: true } } },
    }),
    vehicle.createdBy
      ? prisma.user.findUnique({
          where: { id: vehicle.createdBy },
          select: { email: true },
        })
      : Promise.resolve(null),
  ]);

  return ok({
    ...serializeVehicle(vehicle),
    createdByEmail: creator?.email ?? null,
    recentLeases: leases.map((l) => ({
      id: l.id,
      operatorEmail: l.operator.email,
      status: l.status,
      createdAt: l.createdAt.toISOString(),
      expiresAt: l.expiresAt.toISOString(),
      releasedAt: l.releasedAt?.toISOString() ?? null,
      revokedAt: l.revokedAt?.toISOString() ?? null,
    })),
    recentSessions: sessions.map((s) => ({
      sessionId: s.sessionId,
      userEmail: s.user.email,
      purpose: s.purpose,
      status: s.status,
      createdAt: s.createdAt.toISOString(),
      closedAt: s.closedAt?.toISOString() ?? null,
    })),
  });
});

export const PATCH = withAdmin<Ctx>(async (request, auth, context) => {
  const { id } = await context.params;
  const vehicle = await findVehicleOr404(id);

  const parsed = updateVehicleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new UnprocessableEntity("validation_error", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const patch = parsed.data;

  // Adapter ↔ vehicleType pairing must stay valid after the patch.
  const nextAdapterId = patch.adapterType ?? vehicle.adapterType;
  const nextVehicleType = patch.vehicleType ?? vehicle.vehicleType;
  const adapter = findAdapterType(nextAdapterId);
  if (patch.adapterType !== undefined && !adapter) {
    throw new UnprocessableEntity("unknown_adapter_type", {
      adapterType: nextAdapterId,
    });
  }
  if (adapter && !adapter.vehicleTypes.includes(nextVehicleType)) {
    throw new UnprocessableEntity("adapter_vehicle_type_mismatch", {
      adapterType: nextAdapterId,
      vehicleType: nextVehicleType,
      supported: adapter.vehicleTypes,
    });
  }

  // Field-level diff for the audit trail — only fields that actually change.
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const [key, next] of Object.entries(patch)) {
    const prev = vehicle[key as keyof Vehicle];
    const changed = Array.isArray(next)
      ? JSON.stringify(next) !== JSON.stringify(prev)
      : next !== prev;
    if (changed) diff[key] = { from: prev, to: next };
  }

  if (Object.keys(diff).length === 0) {
    return ok(serializeVehicle(vehicle));
  }

  const updated = await prisma.vehicle.update({
    where: { id: vehicle.id },
    data: patch as Prisma.VehicleUpdateInput,
  });

  await logAudit({
    actorId: auth.userId,
    eventName: "vehicle_updated",
    targetType: "Vehicle",
    targetId: vehicle.vehicleId,
    payload: { diff },
  });

  return ok(serializeVehicle(updated));
});

export const DELETE = withAdmin<Ctx>(async (_request, auth, context) => {
  const { id } = await context.params;
  const vehicle = await findVehicleOr404(id);

  if (vehicle.archivedAt) {
    throw new Conflict("vehicle_already_archived", {
      archivedAt: vehicle.archivedAt.toISOString(),
    });
  }

  const archived = await prisma.vehicle.update({
    where: { id: vehicle.id },
    data: { archivedAt: new Date() },
  });

  await logAudit({
    actorId: auth.userId,
    eventName: "vehicle_archived",
    targetType: "Vehicle",
    targetId: vehicle.vehicleId,
    payload: { displayName: vehicle.displayName },
  });

  return ok(serializeVehicle(archived));
});
