import { z } from "zod";
import { VehicleType } from "@prisma/client";

/**
 * c15 P3 — Zod input schemas for the admin vehicle CRUD API.
 * Kept in backend/lib (not packages/shared) because they validate admin-only
 * server input; the shared package carries edge↔operator wire schemas.
 */

const vehicleTypeSchema = z.nativeEnum(VehicleType);

/** Machine ids: lowercase alnum + dash/underscore, 3-64 chars. */
const machineId = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase alphanumeric, dash or underscore");

const capabilityName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const createVehicleSchema = z
  .object({
    vehicleId: machineId,
    displayName: z.string().min(1).max(120),
    vehicleType: vehicleTypeSchema,
    adapterType: z.string().min(1).max(64),
    platformId: z.string().min(1).max(120),
    cameraProfileId: z.string().min(1).max(120),
    audioProfileId: z.string().min(1).max(120),
    vendor: z.string().max(120).optional(),
    serialNumber: z.string().max(120).optional(),
    declaredCapabilities: z.array(capabilityName).max(64).optional(),
    maxLinearMs: z.number().positive().max(20).optional(),
    maxAngularRads: z.number().positive().max(12.6).optional(),
  })
  .strict();

export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;

/**
 * Partial update — immutable fields (vehicleId / createdAt / createdBy /
 * archivedAt) are intentionally absent; `.strict()` rejects them with 422
 * instead of silently ignoring, so callers learn the contract.
 */
export const updateVehicleSchema = z
  .object({
    displayName: z.string().min(1).max(120),
    vehicleType: vehicleTypeSchema,
    adapterType: z.string().min(1).max(64),
    platformId: z.string().min(1).max(120),
    cameraProfileId: z.string().min(1).max(120),
    audioProfileId: z.string().min(1).max(120),
    vendor: z.string().max(120).nullable(),
    serialNumber: z.string().max(120).nullable(),
    declaredCapabilities: z.array(capabilityName).max(64),
    observedCapabilities: z.array(capabilityName).max(64),
    maxLinearMs: z.number().positive().max(20),
    maxAngularRads: z.number().positive().max(12.6),
  })
  .partial()
  .strict();

export type UpdateVehicleInput = z.infer<typeof updateVehicleSchema>;

const DAY_S = 24 * 60 * 60;

export const mintVehicleTokenSchema = z
  .object({
    /** Token lifetime in seconds — 1 min .. 30 days, default 24 h. */
    ttlSeconds: z
      .number()
      .int()
      .min(60)
      .max(30 * DAY_S)
      .default(DAY_S),
    identity: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
      .default("vehicle-edge"),
  })
  .strict();

export type MintVehicleTokenInput = z.infer<typeof mintVehicleTokenSchema>;
