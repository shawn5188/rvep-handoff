import { LeaseStatus, Prisma, SessionStatus } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok } from "@/lib/api-response";
import { Conflict, UnprocessableEntity } from "@/lib/errors";
import { withAdmin } from "@/middleware/require-admin";
import { logAudit } from "@/lib/audit";
import { createVehicleSchema } from "@/lib/admin-vehicle-schemas";
import { serializeVehicle } from "@/lib/admin-vehicle-serializer";
import { findAdapterType } from "@/lib/adapter-registry";

/**
 * c15 P3 — admin vehicle collection.
 *
 * GET  /api/v1/admin/vehicles[?includeArchived=1]
 *   Full vehicle rows + live stats (activeSessionCount / hasActiveLease /
 *   lastSeenAt). Archived vehicles are hidden unless includeArchived=1.
 *
 * POST /api/v1/admin/vehicles
 *   Create a vehicle. 409 vehicle_id_taken on duplicate vehicleId.
 */

export const GET = withAdmin(async (request) => {
  const includeArchived =
    new URL(request.url).searchParams.get("includeArchived") === "1";

  const now = new Date();
  const [vehicles, sessionCounts, activeLeases, lastFrames] = await Promise.all([
    prisma.vehicle.findMany({
      where: includeArchived ? {} : { archivedAt: null },
      orderBy: { vehicleId: "asc" },
    }),
    // Session.vehicleId / ControlLease.vehicleId reference Vehicle.id (internal);
    // TelemetryFrame.vehicleId references Vehicle.vehicleId (external).
    prisma.session.groupBy({
      by: ["vehicleId"],
      where: { status: SessionStatus.ACTIVE },
      _count: { _all: true },
    }),
    prisma.controlLease.groupBy({
      by: ["vehicleId"],
      where: { status: LeaseStatus.ACTIVE, expiresAt: { gt: now } },
      _count: { _all: true },
    }),
    prisma.telemetryFrame.groupBy({
      by: ["vehicleId"],
      _max: { ts: true },
    }),
  ]);

  const sessionsByInternalId = new Map(
    sessionCounts.map((s) => [s.vehicleId, s._count._all]),
  );
  const leasesByInternalId = new Set(activeLeases.map((l) => l.vehicleId));
  const lastSeenByVehicleId = new Map(
    lastFrames.map((f) => [f.vehicleId, f._max.ts]),
  );

  return ok(
    vehicles.map((v) => ({
      ...serializeVehicle(v),
      activeSessionCount: sessionsByInternalId.get(v.id) ?? 0,
      hasActiveLease: leasesByInternalId.has(v.id),
      lastSeenAt: lastSeenByVehicleId.get(v.vehicleId)?.toISOString() ?? null,
    })),
  );
});

export const POST = withAdmin(async (request, auth) => {
  const parsed = createVehicleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new UnprocessableEntity("validation_error", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const input = parsed.data;

  const adapter = findAdapterType(input.adapterType);
  if (!adapter) {
    throw new UnprocessableEntity("unknown_adapter_type", {
      adapterType: input.adapterType,
    });
  }
  if (!adapter.vehicleTypes.includes(input.vehicleType)) {
    throw new UnprocessableEntity("adapter_vehicle_type_mismatch", {
      adapterType: input.adapterType,
      vehicleType: input.vehicleType,
      supported: adapter.vehicleTypes,
    });
  }

  const declaredCapabilities =
    input.declaredCapabilities ?? adapter.defaultCapabilities;

  // Explicit pre-check for the common duplicate case; the P2002 catch below
  // covers the create-create race. (Also: the pglite test gateway drops the
  // connection on constraint violations, so the happy 409 path must not rely
  // on the DB error.)
  const existing = await prisma.vehicle.findUnique({
    where: { vehicleId: input.vehicleId },
    select: { id: true },
  });
  if (existing) {
    throw new Conflict("vehicle_id_taken", { vehicleId: input.vehicleId });
  }

  let vehicle;
  try {
    vehicle = await prisma.vehicle.create({
      data: {
        vehicleId: input.vehicleId,
        displayName: input.displayName,
        vehicleType: input.vehicleType,
        adapterType: input.adapterType,
        platformId: input.platformId,
        cameraProfileId: input.cameraProfileId,
        audioProfileId: input.audioProfileId,
        vendor: input.vendor ?? null,
        serialNumber: input.serialNumber ?? null,
        declaredCapabilities,
        maxLinearMs: input.maxLinearMs ?? 0.5,
        maxAngularRads: input.maxAngularRads ?? 1.0,
        createdBy: auth.userId,
        // DEPRECATED column (removal target 2026-12-06 / v2.5) — kept in sync
        // for legacy readers until sunset.
        capabilities: { declared: declaredCapabilities } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new Conflict("vehicle_id_taken", { vehicleId: input.vehicleId });
    }
    throw err;
  }

  await logAudit({
    actorId: auth.userId,
    eventName: "vehicle_created",
    targetType: "Vehicle",
    targetId: vehicle.vehicleId,
    payload: {
      vehicleId: vehicle.vehicleId,
      displayName: vehicle.displayName,
      vehicleType: vehicle.vehicleType,
      adapterType: vehicle.adapterType,
    },
  });

  return ok(
    {
      ...serializeVehicle(vehicle),
      activeSessionCount: 0,
      hasActiveLease: false,
      lastSeenAt: null,
    },
    201,
  );
});
