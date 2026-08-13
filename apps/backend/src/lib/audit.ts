import { prisma } from "@/lib/db";
import { EventLogCategory, Prisma } from "@prisma/client";

export interface AuditParams {
  eventName: string;
  vehicleId?: string;
  sessionId?: string;
  userId?: string;
  payload?: Record<string, unknown>;
  /** Defaults to SYSTEM — per c15 P1, every new EventLog row must set category. */
  category?: EventLogCategory;
}

/**
 * Write an event to the EventLog table (legacy call sites: lease / auth /
 * livekit / control events).
 * Errors are intentionally swallowed with console.error —
 * a failed audit write must never crash the main request path.
 */
export async function audit(params: AuditParams): Promise<void> {
  try {
    await prisma.eventLog.create({
      data: {
        eventName: params.eventName,
        category: params.category ?? EventLogCategory.SYSTEM,
        vehicleId: params.vehicleId ?? null,
        sessionId: params.sessionId ?? null,
        userId: params.userId ?? null,
        payload: params.payload
          ? (params.payload as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
  } catch (err) {
    console.error("[audit] Failed to write event", params.eventName, err);
  }
}

export interface LogAuditParams {
  /** userId of the admin / user who performed the action. */
  actorId: string;
  /** e.g. 'user_created' | 'vehicle_added' | 'role_changed' | 'admin_api_access' */
  eventName: string;
  /** 'User' | 'Vehicle' | 'Lease' | 'Permission' */
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
  /** Multi-tenant ready — leave undefined for single-tenant (c15 behaviour). */
  tenantId?: string;
}

/**
 * c15 P2 — canonical audit-trail helper for the Admin Onboarding Suite.
 * ALL admin mutations (P3-P7: vehicle CRUD, user CRUD, permission matrix,
 * token mint, ...) must call this so the audit viewer / dashboard see them.
 *
 * Writes an EventLog row with category=AUDIT + actor/target/tenant columns
 * (added by the c15 P1 migration). `userId` is mirrored from `actorId` so
 * legacy audit queries keep working.
 *
 * Never throws — a failed audit write must not break the admin action itself.
 */
export async function logAudit(opts: LogAuditParams): Promise<void> {
  try {
    await prisma.eventLog.create({
      data: {
        eventName: opts.eventName,
        category: EventLogCategory.AUDIT,
        actorId: opts.actorId,
        userId: opts.actorId, // legacy-compat mirror
        targetType: opts.targetType ?? null,
        targetId: opts.targetId ?? null,
        tenantId: opts.tenantId ?? null,
        payload: opts.payload
          ? (opts.payload as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
  } catch (err) {
    console.error("[audit] Failed to write audit event", opts.eventName, err);
  }
}
