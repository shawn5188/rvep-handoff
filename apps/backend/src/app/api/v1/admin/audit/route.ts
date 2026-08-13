import { prisma } from "@/lib/db";
import { ok } from "@/lib/api-response";
import { UnprocessableEntity } from "@/lib/errors";
import { withAdmin } from "@/middleware/require-admin";
import {
  auditQuerySchema,
  searchParamsToObject,
} from "@/lib/admin-audit-schemas";
import {
  buildAuditWhere,
  buildLabelMaps,
  decodeCursor,
  encodeCursor,
  serializeAuditEvent,
} from "@/lib/admin-audit-serializer";

/**
 * c15 P6 — GET /api/v1/admin/audit
 *
 * Filterable audit timeline, newest first, keyset-paginated:
 *   ?since=&until=&eventName=user_created,user_role_changed&category=AUDIT
 *   &actorId=&targetType=&targetId=&limit=100&cursor=...
 *
 * Response: { events: SerializedAuditEvent[], nextCursor: string | null }
 *
 * Live updates are polling-based (the web viewer re-queries with
 * since=<newest seen ts> every 5 s) — no SSE/WebSocket infra needed.
 * Access itself is audited by withAdmin (admin_api_access).
 */

export const GET = withAdmin(async (request) => {
  const params = new URL(request.url).searchParams;
  const parsed = auditQuerySchema.safeParse(searchParamsToObject(params));
  if (!parsed.success) {
    throw new UnprocessableEntity("validation_error", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const q = parsed.data;

  const where = buildAuditWhere(q);
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    if (!c) {
      throw new UnprocessableEntity("invalid_cursor");
    }
    // Keyset condition matching orderBy [ts desc, id desc]:
    // strictly older, or same ts with a smaller id.
    where.AND = [
      {
        OR: [
          { ts: { lt: c.ts } },
          { ts: c.ts, id: { lt: c.id } },
        ],
      },
    ];
  }

  // take limit+1 — the extra row only signals "there is a next page".
  const rows = await prisma.eventLog.findMany({
    where,
    orderBy: [{ ts: "desc" }, { id: "desc" }],
    take: q.limit + 1,
  });
  const hasMore = rows.length > q.limit;
  const page = rows.slice(0, q.limit);

  const maps = await buildLabelMaps(page);
  const last = page[page.length - 1];

  return ok({
    events: page.map((e) => serializeAuditEvent(e, maps)),
    nextCursor: hasMore && last ? encodeCursor(last.id, last.ts) : null,
  });
});
