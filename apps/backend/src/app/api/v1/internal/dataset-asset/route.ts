import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { ok, fail } from "@/lib/api-response";
import { validateBody } from "@/lib/validation";
import { AppError } from "@/lib/errors";
import {
  DatasetAssetKind,
  DatasetAssetSource,
  Prisma,
  RetentionTier,
  Role,
  SessionPurpose,
  SessionStatus,
} from "@prisma/client";

/**
 * Internal endpoint called by Edge Agent on session-end / chunk-finalize to
 * register a dataset artefact (metadata.jsonl, video chunk, etc.) for later
 * indexing and retention enforcement.
 *
 * Source spec:
 *   - openspec/features/c4-ai-training-data-storage.md
 *   - openspec/data/metadata-jsonl.md
 *
 * Phase 1 simplifications:
 *   - Auto-creates the Session row if it does not exist yet (edge boots BEFORE
 *     any web session). Owner is a "system" user we lazily create.
 *   - Path is the on-edge absolute path; central sync happens in Phase 2.
 */

const SYSTEM_EMAIL = "system@edge.local";

const datasetAssetSchema = z.object({
  vehicleId: z.string().min(1),
  sessionId: z.string().min(1), // business sessionId (string) from edge
  cameraId: z.string().nullable().optional(),
  kind: z.nativeEnum(DatasetAssetKind),
  source: z.nativeEnum(DatasetAssetSource),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable().optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});

const INTERNAL_TOKEN = process.env.EDGE_INTERNAL_TOKEN ?? "internal-dev-token";

async function getOrCreateSystemUser() {
  const existing = await prisma.user.findUnique({ where: { email: SYSTEM_EMAIL } });
  if (existing) return existing;
  return prisma.user.create({
    data: {
      email: SYSTEM_EMAIL,
      // System user can never log in interactively — store a non-bcrypt sentinel
      // that no real login flow can ever match.
      passwordHash: "system-no-login",
      role: Role.ADMIN,
    },
  });
}

async function getOrCreateSession(
  vehicleInternalId: string,
  sessionIdString: string,
  systemUserId: string,
) {
  const existing = await prisma.session.findUnique({ where: { sessionId: sessionIdString } });
  if (existing) return existing;
  return prisma.session.create({
    data: {
      sessionId: sessionIdString,
      vehicleId: vehicleInternalId,
      userId: systemUserId,
      purpose: SessionPurpose.DATASET,
      status: SessionStatus.ACTIVE,
    },
  });
}

export async function POST(request: NextRequest) {
  if (request.headers.get("x-internal-token") !== INTERNAL_TOKEN) {
    return fail("unauthorized_internal", 401);
  }

  try {
    const body = await validateBody(request, datasetAssetSchema);

    const vehicle = await prisma.vehicle.findUnique({
      where: { vehicleId: body.vehicleId },
    });
    if (!vehicle) return fail("vehicle_not_found", 404);

    const systemUser = await getOrCreateSystemUser();
    const session = await getOrCreateSession(vehicle.id, body.sessionId, systemUser.id);

    const asset = await prisma.datasetAsset.create({
      data: {
        vehicleId: vehicle.vehicleId,
        sessionId: session.id, // FK references Session.id (UUID), not business sessionId
        cameraId: body.cameraId ?? null,
        kind: body.kind,
        source: body.source,
        path: body.path,
        sizeBytes: body.sizeBytes != null ? BigInt(body.sizeBytes) : null,
        durationMs: body.durationMs != null ? BigInt(body.durationMs) : null,
        sha256: body.sha256 ?? null,
        retentionTier: RetentionTier.ROLLING_30D,
        metadata:
          body.metadata !== undefined
            ? (body.metadata as Prisma.InputJsonValue)
            : undefined,
      },
    });

    return ok({
      id: asset.id,
      sessionId: session.sessionId,
      kind: asset.kind,
      path: asset.path,
      registeredAt: asset.createdAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof AppError) {
      return fail(err.code, err.status, err.extra);
    }
    if (err instanceof z.ZodError) {
      return fail("invalid_payload", 400, { issues: err.errors });
    }
    console.error("[internal/dataset-asset]", err);
    return fail("internal_error", 500);
  }
}
