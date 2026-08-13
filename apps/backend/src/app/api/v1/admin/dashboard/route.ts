import { EventLogCategory } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok } from "@/lib/api-response";
import { withAdmin } from "@/middleware/require-admin";

/**
 * GET /api/v1/admin/dashboard
 *
 * c15 P2 — admin dashboard aggregate:
 *   { vehicleCount, userCount, recentAuditCount, recentEvents }
 *
 * - Counts exclude soft-deleted rows (archivedAt != null).
 * - recentAuditCount = AUDIT events in the last 24 h.
 * - recentEvents = latest 5 AUDIT events.
 * - `admin_api_access` / `admin_api_denied` access-log noise is excluded from
 *   both, otherwise the dashboard's own polling would dominate the timeline.
 */

const ACCESS_LOG_EVENTS = ["admin_api_access", "admin_api_denied"];

export const GET = withAdmin(async () => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const auditWhere = {
    category: EventLogCategory.AUDIT,
    eventName: { notIn: ACCESS_LOG_EVENTS },
  };

  const [vehicleCount, userCount, recentAuditCount, recentEvents] =
    await Promise.all([
      prisma.vehicle.count({ where: { archivedAt: null } }),
      prisma.user.count({ where: { archivedAt: null } }),
      prisma.eventLog.count({ where: { ...auditWhere, ts: { gte: since } } }),
      prisma.eventLog.findMany({
        where: auditWhere,
        orderBy: { ts: "desc" },
        take: 5,
        select: {
          id: true,
          ts: true,
          eventName: true,
          actorId: true,
          targetType: true,
          targetId: true,
          payload: true,
        },
      }),
    ]);

  return ok({
    vehicleCount,
    userCount,
    recentAuditCount,
    recentEvents: recentEvents.map((e) => ({
      id: e.id.toString(),
      ts: e.ts.toISOString(),
      eventName: e.eventName,
      actorId: e.actorId,
      targetType: e.targetType,
      targetId: e.targetId,
      payload: e.payload as Record<string, unknown> | null,
    })),
  });
});
