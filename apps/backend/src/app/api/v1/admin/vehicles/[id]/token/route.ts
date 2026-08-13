import { ok } from "@/lib/api-response";
import { UnprocessableEntity } from "@/lib/errors";
import { withAdmin } from "@/middleware/require-admin";
import { logAudit } from "@/lib/audit";
import { issueVehicleEdgeToken } from "@/lib/livekit";
import { mintVehicleTokenSchema } from "@/lib/admin-vehicle-schemas";
import { findVehicleOr404 } from "@/lib/admin-vehicle-serializer";

/**
 * c15 P3 — POST /api/v1/admin/vehicles/:id/token
 *
 * Mint a LiveKit edge token for a vehicle deployment (publisher grants,
 * default identity "vehicle-edge", default TTL 24 h; body may override both).
 * Response: { token, expiresAt, roomName, identity, url }.
 */

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAdmin<Ctx>(async (request, auth, context) => {
  const { id } = await context.params;
  const vehicle = await findVehicleOr404(id);

  // Body is optional — empty body means defaults.
  const raw = await request.json().catch(() => ({}));
  const parsed = mintVehicleTokenSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new UnprocessableEntity("validation_error", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const { ttlSeconds, identity } = parsed.data;

  const result = await issueVehicleEdgeToken(vehicle.vehicleId, {
    ttlSeconds,
    identity,
  });

  await logAudit({
    actorId: auth.userId,
    eventName: "vehicle_token_minted",
    targetType: "Vehicle",
    targetId: vehicle.vehicleId,
    payload: { ttl: ttlSeconds, identity },
  });

  return ok({
    token: result.token,
    expiresAt: result.expiresAt.toISOString(),
    roomName: result.roomName,
    identity: result.identity,
    url: result.url,
  });
});
