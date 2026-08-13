import { z } from "zod";
import { Role } from "@prisma/client";

/**
 * c15 P5 — Zod input schemas for the admin permission-matrix API.
 * Same convention as admin-vehicle/user-schemas: .strict() so unknown fields
 * are rejected with 422 instead of silently ignored.
 */

const roleSchema = z.nativeEnum(Role);

/**
 * One user×vehicle permission entry.
 * NOTE: vehicleId here is Vehicle.id (internal UUID), NOT the external
 * machine id (Vehicle.vehicleId, e.g. "amr-01") — it matches the
 * VehiclePermission FK and what GET /admin/permissions returns as vehicleId.
 */
const permissionEntrySchema = z
  .object({
    vehicleId: z.string().uuid(),
    role: roleSchema,
    /** null / omitted = use role default (per c14: ADMIN 100 / OPERATOR 50 / VIEWER 0). */
    priorityOverride: z.number().int().min(0).max(100).nullable().optional(),
  })
  .strict();

export type PermissionEntryInput = z.infer<typeof permissionEntrySchema>;

/** PUT /api/v1/admin/permissions — full replace of one user's permissions. */
export const putUserPermissionsSchema = z
  .object({
    userId: z.string().uuid(),
    permissions: z.array(permissionEntrySchema).max(500), // sanity cap
  })
  .strict()
  .superRefine((val, ctx) => {
    const seen = new Set<string>();
    for (const [i, entry] of val.permissions.entries()) {
      if (seen.has(entry.vehicleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["permissions", i, "vehicleId"],
          message: "duplicate vehicleId in permissions array",
        });
      }
      seen.add(entry.vehicleId);
    }
  });

export type PutUserPermissionsInput = z.infer<typeof putUserPermissionsSchema>;

/** GET /api/v1/admin/permissions/matrix query params. */
export const matrixQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type MatrixQueryInput = z.infer<typeof matrixQuerySchema>;
