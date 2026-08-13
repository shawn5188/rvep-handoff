import { prisma } from "@/lib/db";
import { AppError, UnprocessableEntity } from "@/lib/errors";
import { withAdmin } from "@/middleware/require-admin";
import { logAudit } from "@/lib/audit";
import {
  auditExportQuerySchema,
  searchParamsToObject,
} from "@/lib/admin-audit-schemas";
import {
  buildAuditWhere,
  buildLabelMaps,
  csvEscape,
  EXPORT_MAX_ROWS,
  serializeAuditEvent,
} from "@/lib/admin-audit-serializer";

/**
 * c15 P6 — GET /api/v1/admin/audit/export
 *
 * CSV export for compliance review. Same filters as the list endpoint but no
 * cursor / limit — the whole filtered set is returned, hard-capped at
 * EXPORT_MAX_ROWS (400 export_too_large beyond that; narrow with since/until).
 *
 * Excel-compat: UTF-8 BOM prefix + CRLF line endings + formula-injection
 * guard (see csvEscape). The export itself is audited (audit_log_exported).
 */

const CSV_COLUMNS = [
  "ts",
  "category",
  "eventName",
  "importance",
  "actorEmail",
  "targetType",
  "targetId",
  "targetLabel",
  "payloadJSON",
] as const;

export const GET = withAdmin(async (request, auth) => {
  const params = new URL(request.url).searchParams;
  const parsed = auditExportQuerySchema.safeParse(searchParamsToObject(params));
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
  const rowCount = await prisma.eventLog.count({ where });
  if (rowCount > EXPORT_MAX_ROWS) {
    throw new AppError("export_too_large", 400, {
      rowCount,
      maxRows: EXPORT_MAX_ROWS,
      hint: "narrow the export with since/until or eventName filters",
    });
  }

  const rows = await prisma.eventLog.findMany({
    where,
    orderBy: [{ ts: "desc" }, { id: "desc" }],
  });
  const maps = await buildLabelMaps(rows);

  const lines: string[] = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const e = serializeAuditEvent(row, maps);
    lines.push(
      [
        e.ts,
        e.category ?? "",
        e.eventName,
        e.importance,
        e.actorEmail ?? "",
        e.targetType ?? "",
        e.targetId ?? "",
        e.targetLabel ?? "",
        e.payload ? JSON.stringify(e.payload) : "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  // UTF-8 BOM so Excel opens the file as UTF-8; CRLF per RFC 4180.
  const csv = "\uFEFF" + lines.join("\r\n") + "\r\n";

  await logAudit({
    actorId: auth.userId,
    eventName: "audit_log_exported",
    payload: {
      rowCount: rows.length,
      filter: {
        category: q.category,
        ...(q.since ? { since: q.since } : {}),
        ...(q.until ? { until: q.until } : {}),
        ...(q.eventName ? { eventName: q.eventName } : {}),
        ...(q.actorId ? { actorId: q.actorId } : {}),
        ...(q.targetType ? { targetType: q.targetType } : {}),
        ...(q.targetId ? { targetId: q.targetId } : {}),
      },
    },
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="rvep-audit-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
