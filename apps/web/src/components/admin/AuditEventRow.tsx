"use client";

import Link from "next/link";
import { AdminAuditEventDetail, AuditImportance } from "@/lib/api-client";
import { AuditPayloadViewer } from "@/components/admin/AuditPayloadViewer";

/**
 * c15 P6 — one audit event: compact row (desktop) / card (mobile).
 * Importance renders as a left border (red / orange / neutral) per SEC
 * expert highlight spec. Click anywhere toggles the JSON payload viewer.
 */

const BORDER: Record<AuditImportance, string> = {
  red: "border-l-[var(--accent-red)]",
  orange: "border-l-amber-400",
  default: "border-l-transparent",
};

const PILL: Record<AuditImportance, string> = {
  red: "bg-red-500/15 text-red-300 border-red-500/30",
  orange: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  default: "bg-neutral-500/15 text-neutral-300 border-neutral-500/30",
};

export function fmtRelative(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (diff < 0 || diff < 45_000) return "剛剛";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} 分鐘前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小時前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(iso).toLocaleDateString("zh-TW");
}

function fmtAbsolute(iso: string): string {
  return new Date(iso).toLocaleString("zh-TW", { hour12: false });
}

function targetHref(e: AdminAuditEventDetail): string | null {
  if (!e.targetId) return null;
  if (e.targetType === "User") {
    return `/admin/users/${encodeURIComponent(e.targetId)}`;
  }
  if (e.targetType === "Vehicle") {
    // targetId is the external machine id — matches /admin/vehicles routes.
    return `/admin/vehicles/${encodeURIComponent(e.targetId)}`;
  }
  return null;
}

export function AuditEventRow({
  event,
  expanded,
  onToggle,
}: {
  event: AdminAuditEventDetail;
  expanded: boolean;
  onToggle: () => void;
}) {
  const href = targetHref(event);
  const targetText = event.targetLabel ?? event.targetId;

  return (
    <div
      className={`border-l-4 ${BORDER[event.importance]} border-b border-b-[var(--border-subtle)] last:border-b-0`}
      data-testid={`audit-event-${event.id}`}
      data-importance={event.importance}
    >
      {/* div+role instead of <button>: the target link nests inside (invalid in a real button) */}
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        aria-expanded={expanded}
        className="w-full text-left px-3 py-2.5 min-h-11 hover:bg-white/[0.03] transition-colors cursor-pointer"
      >
        {/* one flex-wrap layout: single line on desktop, wraps into a card on mobile */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className="text-xs font-mono text-neutral-400 whitespace-nowrap w-20 shrink-0"
            title={fmtAbsolute(event.ts)}
          >
            {fmtRelative(event.ts)}
          </span>
          <span
            className={`px-2 py-0.5 rounded-md border text-xs font-mono whitespace-nowrap ${PILL[event.importance]}`}
          >
            {event.eventName}
          </span>
          <span className="text-sm text-neutral-300 font-mono truncate max-w-[14rem]">
            {event.actorEmail ?? event.actorId ?? "system"}
          </span>
          {targetText && (
            <span className="text-xs text-neutral-500 truncate max-w-[16rem]">
              →{" "}
              {href ? (
                <Link
                  href={href}
                  onClick={(e) => e.stopPropagation()}
                  className="text-[var(--accent-blue)] hover:underline"
                >
                  {targetText}
                </Link>
              ) : (
                targetText
              )}
              {event.targetType && (
                <span className="ml-1 text-neutral-600">({event.targetType})</span>
              )}
            </span>
          )}
          <span className="ml-auto hidden md:inline text-[11px] font-mono text-neutral-600 whitespace-nowrap">
            {fmtAbsolute(event.ts)}
          </span>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-3 md:px-6">
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-neutral-500">
            <span>id {event.id}</span>
            <span>category {event.category ?? "—"}</span>
            {event.targetId && <span>targetId {event.targetId}</span>}
            {event.tenantId && <span>tenant {event.tenantId}</span>}
          </div>
          <AuditPayloadViewer payload={event.payload} />
        </div>
      )}
    </div>
  );
}
