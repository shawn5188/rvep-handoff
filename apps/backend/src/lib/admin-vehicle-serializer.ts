import { Vehicle } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFound } from "@/lib/errors";

/**
 * Resolve an admin route `[id]` segment (external vehicleId, e.g. "amr-01")
 * to the Vehicle row. Throws 404 vehicle_not_found when absent.
 */
export async function findVehicleOr404(externalId: string): Promise<Vehicle> {
  const vehicle = await prisma.vehicle.findUnique({
    where: { vehicleId: externalId },
  });
  if (!vehicle) throw new NotFound("vehicle_not_found");
  return vehicle;
}

/**
 * c15 P3 — single wire shape for admin vehicle responses (list + detail +
 * create). Kept in lib because Next.js route files may only export handlers.
 */
export function serializeVehicle(v: Vehicle) {
  return {
    id: v.id,
    vehicleId: v.vehicleId,
    displayName: v.displayName,
    vehicleType: v.vehicleType,
    adapterType: v.adapterType,
    platformId: v.platformId,
    cameraProfileId: v.cameraProfileId,
    audioProfileId: v.audioProfileId,
    status: v.status,
    vendor: v.vendor,
    serialNumber: v.serialNumber,
    declaredCapabilities: v.declaredCapabilities,
    observedCapabilities: v.observedCapabilities,
    maxLinearMs: v.maxLinearMs,
    maxAngularRads: v.maxAngularRads,
    createdBy: v.createdBy,
    archivedAt: v.archivedAt ? v.archivedAt.toISOString() : null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

export type SerializedVehicle = ReturnType<typeof serializeVehicle>;
