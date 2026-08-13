import { z } from "zod";

/**
 * c15 P6 — Zod input schemas for the admin audit-log API.
 * Same convention as admin-vehicle/user/permission-schemas: .strict() so
 * unknown query params are rejected with 422 instead of silently ignored.
 *
 * All values arrive as URL query strings, so numbers are coerced and the
 * eventName filter is a comma-separated list split into an array.
 */

/** "user_created,role_changed" → ["user_created", "role_changed"] */
const eventNameListSchema = z
  .string()
  .min(1)
  .transform((s) =>
    s
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1).max(100)).min(1).max(50));

const isoDatetime = z.string().datetime({ offset: true });

export const auditCategorySchema = z.enum(["AUDIT", "TELEMETRY", "SYSTEM"]);

export type AuditCategoryInput = z.infer<typeof auditCategorySchema>;

/** GET /api/v1/admin/audit query params (keyset pagination). */
export const auditQuerySchema = z
  .object({
    since: isoDatetime.optional(),
    until: isoDatetime.optional(),
    eventName: eventNameListSchema.optional(),
    /** Default AUDIT — the viewer is an audit trail first. */
    category: auditCategorySchema.default("AUDIT"),
    actorId: z.string().uuid().optional(),
    targetType: z.string().min(1).max(64).optional(),
    /** User uuid / vehicle external id / lease id — free-form key. */
    targetId: z.string().min(1).max(128).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    /** base64url({ id, ts }) — see encodeCursor / decodeCursor. */
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type AuditQueryInput = z.infer<typeof auditQuerySchema>;

/**
 * GET /api/v1/admin/audit/export — same filters, but no pagination:
 * the export always returns the whole (capped) filtered set.
 */
export const auditExportQuerySchema = auditQuerySchema.omit({
  limit: true,
  cursor: true,
});

export type AuditExportQueryInput = z.infer<typeof auditExportQuerySchema>;

/**
 * URLSearchParams → plain object for .strict() parsing.
 * Repeated keys keep the last value (filters are single-valued;
 * eventName uses comma separation instead of repetition).
 */
export function searchParamsToObject(
  params: URLSearchParams,
): Record<string, string> {
  return Object.fromEntries(params.entries());
}
