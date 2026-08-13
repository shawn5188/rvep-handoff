import { EventLog, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { AuditQueryInput } from "@/lib/admin-audit-schemas";

/**
 * c15 P6 — wire shape + helpers for the admin audit-log API.
 *
 * - keyset cursor (base64url of { id, ts }) — offset pagination degrades on a
 *   log table, keyset stays O(page) on the (category, ts) index
 * - actor / target label joins are batched (one user + one vehicle query per
 *   page, never per row)
 * - importance classification per SEC expert input (red / orange / default)
 */

// ---------------------------------------------------------------------------
// Keyset cursor
// ---------------------------------------------------------------------------

export function encodeCursor(id: bigint, ts: Date): string {
  return Buffer.from(
    JSON.stringify({ id: id.toString(), ts: ts.toISOString() }),
    "utf8",
  ).toString("base64url");
}

export function decodeCursor(
  cursor: string,
): { id: bigint; ts: Date } | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { id?: unknown; ts?: unknown };
    if (typeof parsed.id !== "string" || typeof parsed.ts !== "string") {
      return null;
    }
    if (!/^\d+$/.test(parsed.id)) return null;
    const ts = new Date(parsed.ts);
    if (Number.isNaN(ts.getTime())) return null;
    return { id: BigInt(parsed.id), ts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Importance classification (per SEC expert input)
// ---------------------------------------------------------------------------

export type AuditImportance = "red" | "orange" | "default";

/** Privilege escalation / destructive actions. */
const RED_EVENTS = new Set([
  "user_archived",
  "vehicle_archived",
  "last_admin_protected", // red-line rejection, if ever logged as an event
]);

/** Security-sensitive but routine operations. */
const ORANGE_EVENTS = new Set([
  "lease_forced_release",
  "user_password_reset",
]);

/** vehicle_token_minted with ttl beyond this is orange (long-lived secret). */
const TOKEN_TTL_ORANGE_SECONDS = 7 * 24 * 60 * 60;

/** user_permissions_updated touching more rows than this is orange (bulk). */
const BULK_PERMISSION_ORANGE_ROWS = 10;

function asNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function classifyImportance(
  eventName: string,
  payload?: Record<string, unknown> | null,
): AuditImportance {
  if (RED_EVENTS.has(eventName)) return "red";
  // Role escalation to ADMIN — payload shape per P4: { email, from, to }.
  if (eventName === "user_role_changed" && payload?.to === "ADMIN") {
    return "red";
  }

  if (ORANGE_EVENTS.has(eventName)) return "orange";
  // Payload shape per P3: { ttl (seconds), identity }.
  if (
    eventName === "vehicle_token_minted" &&
    asNumber(payload?.ttl) > TOKEN_TTL_ORANGE_SECONDS
  ) {
    return "orange";
  }
  // Payload shape per P5: { added, removed, changed, examples }.
  if (eventName === "user_permissions_updated") {
    const rows =
      asNumber(payload?.added) +
      asNumber(payload?.removed) +
      asNumber(payload?.changed);
    if (rows > BULK_PERMISSION_ORANGE_ROWS) return "orange";
  }

  return "default";
}

// ---------------------------------------------------------------------------
// Prisma where builder (shared by list + export)
// ---------------------------------------------------------------------------

export type AuditFilterInput = Omit<AuditQueryInput, "limit" | "cursor">;

export function buildAuditWhere(
  q: AuditFilterInput,
): Prisma.EventLogWhereInput {
  const where: Prisma.EventLogWhereInput = { category: q.category };
  if (q.since || q.until) {
    where.ts = {
      ...(q.since ? { gte: new Date(q.since) } : {}),
      ...(q.until ? { lte: new Date(q.until) } : {}),
    };
  }
  if (q.eventName && q.eventName.length > 0) {
    where.eventName = { in: q.eventName };
  }
  if (q.actorId) where.actorId = q.actorId;
  if (q.targetType) where.targetType = q.targetType;
  if (q.targetId) where.targetId = q.targetId;
  return where;
}

// ---------------------------------------------------------------------------
// Label joins + serialization
// ---------------------------------------------------------------------------

export interface AuditLabelMaps {
  /** userId → email / displayName (actors + User targets). */
  usersById: Map<string, { email: string; displayName: string | null }>;
  /** external vehicleId (e.g. "amr-01") → displayName (Vehicle targets). */
  vehiclesByExternalId: Map<string, { displayName: string }>;
}

/**
 * Batch-fetch actor + target labels for a page of events.
 * Conventions (P3-P5): targetType "User" → targetId = User.id (uuid);
 * targetType "Vehicle" → targetId = Vehicle.vehicleId (external machine id).
 */
export async function buildLabelMaps(
  events: EventLog[],
): Promise<AuditLabelMaps> {
  const userIds = new Set<string>();
  const vehicleExternalIds = new Set<string>();
  for (const e of events) {
    if (e.actorId) userIds.add(e.actorId);
    if (e.targetId) {
      if (e.targetType === "User") userIds.add(e.targetId);
      else if (e.targetType === "Vehicle") vehicleExternalIds.add(e.targetId);
    }
  }

  const [users, vehicles] = await Promise.all([
    userIds.size > 0
      ? prisma.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, email: true, displayName: true },
        })
      : Promise.resolve([]),
    vehicleExternalIds.size > 0
      ? prisma.vehicle.findMany({
          where: { vehicleId: { in: [...vehicleExternalIds] } },
          select: { vehicleId: true, displayName: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    usersById: new Map(
      users.map((u) => [u.id, { email: u.email, displayName: u.displayName }]),
    ),
    vehiclesByExternalId: new Map(
      vehicles.map((v) => [v.vehicleId, { displayName: v.displayName }]),
    ),
  };
}

export function serializeAuditEvent(e: EventLog, maps: AuditLabelMaps) {
  const payload =
    e.payload && typeof e.payload === "object" && !Array.isArray(e.payload)
      ? (e.payload as Record<string, unknown>)
      : null;

  let targetLabel: string | null = null;
  if (e.targetId) {
    if (e.targetType === "User") {
      const u = maps.usersById.get(e.targetId);
      targetLabel = u ? (u.displayName ?? u.email) : null;
    } else if (e.targetType === "Vehicle") {
      targetLabel = maps.vehiclesByExternalId.get(e.targetId)?.displayName ?? null;
    }
  }

  return {
    id: e.id.toString(),
    ts: e.ts.toISOString(),
    category: e.category ?? null,
    eventName: e.eventName,
    actorId: e.actorId,
    actorEmail: e.actorId ? (maps.usersById.get(e.actorId)?.email ?? null) : null,
    targetType: e.targetType,
    targetId: e.targetId,
    targetLabel,
    payload,
    tenantId: e.tenantId,
    importance: classifyImportance(e.eventName, payload),
  };
}

export type SerializedAuditEvent = ReturnType<typeof serializeAuditEvent>;

// ---------------------------------------------------------------------------
// CSV helpers (export endpoint)
// ---------------------------------------------------------------------------

/** Hard cap on CSV export rows — beyond this the endpoint 400s. */
export const EXPORT_MAX_ROWS = 10_000;

/**
 * RFC 4180 escape + spreadsheet formula-injection guard: cells starting with
 * = + - @ or a tab get a leading apostrophe so Excel treats them as text.
 */
export function csvEscape(value: string): string {
  let v = value;
  if (/^[=+\-@\t]/.test(v)) v = `'${v}`;
  if (/[",\r\n]/.test(v)) v = `"${v.replace(/"/g, '""')}"`;
  return v;
}
