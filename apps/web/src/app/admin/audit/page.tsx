"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  adminExportAuditCsv,
  adminListAudit,
  adminListUsers,
  AdminAuditEventDetail,
  AdminAuditQuery,
  AdminUser,
  ApiError,
} from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import {
  AuditFilterBar,
  AuditFilterState,
  DEFAULT_AUDIT_FILTERS,
} from "@/components/admin/AuditFilterBar";
import { AuditEventRow } from "@/components/admin/AuditEventRow";

/**
 * c15 P6 — /admin/audit: filterable audit timeline.
 * - keyset pagination (infinite scroll + 載入更多 fallback)
 * - live mode: 5 s polling with since=<newest seen ts>, merged + deduped
 * - CSV export with the current filters (server caps at 10,000 rows)
 * - importance highlight (red / orange) per SEC expert input
 * Rendered inside the admin shell (app/admin/layout.tsx).
 */

const PAGE_SIZE = 50;
const LIVE_POLL_MS = 5_000;

const RANGE_MS: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

function localToIso(local: string): string | undefined {
  if (!local) return undefined;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export default function AuditLogPage() {
  const router = useRouter();
  const [filters, setFilters] = useState<AuditFilterState>(DEFAULT_AUDIT_FILTERS);
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [events, setEvents] = useState<AdminAuditEventDetail[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Monotonic id per filter change — stale async results get dropped.
  const queryEpoch = useRef(0);

  // Actor autocomplete + email → actorId resolution.
  useEffect(() => {
    adminListUsers({ includeArchived: true })
      .then(setUsers)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.replace("/login");
        // Non-fatal otherwise — the picker just loses autocomplete.
      });
  }, [router]);

  const actorId = useMemo(() => {
    const q = filters.actorEmail.trim().toLowerCase();
    if (!q || !users) return undefined;
    return users.find((u) => u.email.toLowerCase() === q)?.id;
  }, [filters.actorEmail, users]);

  const actorUnresolved =
    filters.actorEmail.trim() !== "" && users !== null && actorId === undefined;

  /** Current filters → API query (fresh time window on every call). */
  const buildQuery = useCallback((): AdminAuditQuery => {
    let since: string | undefined;
    let until: string | undefined;
    if (filters.range === "custom") {
      since = localToIso(filters.customSince);
      until = localToIso(filters.customUntil);
    } else {
      since = new Date(Date.now() - RANGE_MS[filters.range]).toISOString();
    }
    return {
      since,
      until,
      ...(filters.eventNames.length > 0 ? { eventName: filters.eventNames } : {}),
      ...(actorId ? { actorId } : {}),
      ...(filters.target.trim() ? { targetId: filters.target.trim() } : {}),
    };
  }, [filters, actorId]);

  // Initial load + reload on filter change (300 ms debounce for text inputs).
  useEffect(() => {
    // An unresolved actor email would silently show unfiltered rows — hold off.
    if (actorUnresolved) return;
    const epoch = ++queryEpoch.current;
    const t = setTimeout(async () => {
      try {
        const page = await adminListAudit({ ...buildQuery(), limit: PAGE_SIZE });
        if (queryEpoch.current !== epoch) return;
        setEvents(page.events);
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (err) {
        if (queryEpoch.current !== epoch) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.code : "network_error");
      }
    }, 300);
    return () => clearTimeout(t);
  }, [buildQuery, actorUnresolved, router]);

  // Live mode: poll every 5 s with since=<newest seen ts>, merge + dedupe.
  useEffect(() => {
    if (!filters.live) return;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      if (controller.signal.aborted) return;
      try {
        const newestTs = events?.[0]?.ts;
        const page = await adminListAudit({
          ...buildQuery(),
          ...(newestTs ? { since: newestTs } : {}),
          limit: 100,
        });
        if (controller.signal.aborted) return;
        setEvents((prev) => {
          if (!prev) return page.events;
          const seen = new Set(prev.map((e) => e.id));
          const fresh = page.events.filter((e) => !seen.has(e.id));
          return fresh.length > 0 ? [...fresh, ...prev] : prev;
        });
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
        }
        // Transient poll errors are silent — next tick retries.
      }
    }, LIVE_POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [filters.live, buildQuery, events, router]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    const epoch = queryEpoch.current;
    try {
      const page = await adminListAudit({
        ...buildQuery(),
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      if (queryEpoch.current !== epoch) return;
      setEvents((prev) => {
        const seen = new Set((prev ?? []).map((e) => e.id));
        return [...(prev ?? []), ...page.events.filter((e) => !seen.has(e.id))];
      });
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (queryEpoch.current !== epoch) return;
      setError(err instanceof ApiError ? err.code : "network_error");
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, buildQuery]);

  // Infinite scroll — sentinel below the list.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !nextCursor) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore, nextCursor]);

  async function onExport() {
    setExporting(true);
    setError(null);
    try {
      const blob = await adminExportAuditCsv(buildQuery());
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `rvep-audit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      if (err instanceof ApiError && err.code === "export_too_large") {
        setError("匯出超過 10,000 筆上限 — 請縮小時間範圍或加事件類型篩選");
      } else {
        setError(err instanceof ApiError ? err.code : "export_failed");
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto">
      <section className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">事件審計</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Admin 操作 audit trail — 使用者 / 車輛 / 權限變更全紀錄 · 保留 90 天
        </p>
      </section>

      <AuditFilterBar
        value={filters}
        onChange={setFilters}
        users={users}
        onExport={onExport}
        exporting={exporting}
      />

      {actorUnresolved && (
        <p className="text-xs text-amber-300 mb-3" data-testid="actor-unresolved">
          找不到 email「{filters.actorEmail}」的使用者 — 請從自動完成清單選取
        </p>
      )}

      {error && (
        <p
          className="text-sm text-[var(--accent-red)] mb-4 cursor-pointer"
          onClick={() => setError(null)}
          data-testid="audit-error"
        >
          錯誤：{error}
        </p>
      )}

      {events === null ? (
        <LoadingSkeleton />
      ) : events.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-neutral-500" data-testid="audit-empty">
            無 audit event 符合條件
          </p>
        </Card>
      ) : (
        <>
          <Card className="p-0 overflow-hidden" data-testid="audit-timeline">
            {events.map((e) => (
              <AuditEventRow
                key={e.id}
                event={e}
                expanded={expandedId === e.id}
                onToggle={() => setExpandedId((cur) => (cur === e.id ? null : e.id))}
              />
            ))}
          </Card>

          <div ref={sentinelRef} aria-hidden className="h-1" />

          <div className="mt-4 flex justify-center">
            {nextCursor ? (
              <Button
                variant="ghost"
                size="md"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                data-testid="load-more-btn"
              >
                {loadingMore ? "載入中…" : "載入更多"}
              </Button>
            ) : (
              <p className="text-xs text-neutral-600 py-2">— 已到結尾 —</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <Card className="p-0 overflow-hidden" data-testid="audit-skeleton">
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          className="border-b border-[var(--border-subtle)] last:border-0 px-3 py-3 flex items-center gap-3 animate-pulse"
        >
          <div className="h-3 w-16 rounded bg-white/10" />
          <div className="h-5 w-32 rounded-md bg-white/10" />
          <div className="h-3 w-40 rounded bg-white/10 hidden sm:block" />
          <div className="h-3 w-24 rounded bg-white/5 ml-auto hidden md:block" />
        </div>
      ))}
    </Card>
  );
}
