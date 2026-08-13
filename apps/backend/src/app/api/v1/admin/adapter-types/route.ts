import { ok } from "@/lib/api-response";
import { withAdmin } from "@/middleware/require-admin";
import { ADAPTER_REGISTRY, allKnownCapabilities } from "@/lib/adapter-registry";

/**
 * c15 P3 — GET /api/v1/admin/adapter-types
 *
 * In-code adapter registry (see src/lib/adapter-registry.ts for why this is
 * not a DB table yet). Also returns the capability superset so the vehicle
 * form can render its capability checkbox list from one call.
 */
export const GET = withAdmin(async () => {
  return ok({
    adapterTypes: ADAPTER_REGISTRY,
    allCapabilities: allKnownCapabilities(),
  });
});
