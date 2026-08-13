"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getAdminDashboard,
  ApiError,
  AdminDashboard,
  AdminAuditEvent,
} from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

/**
 * c15 P2 — admin dashboard: 3 metric cards + latest 5 audit events +
 * quick actions. Data from GET /api/v1/admin/dashboard (ADMIN only).
 */
export default function AdminDashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<AdminDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const d = await getAdminDashboard();
        if (!cancelled) {
          setData(d);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        // 401/403 are handled by the layout gate; surface other errors inline.
        setError(err instanceof ApiError ? err.code : "network_error");
      }
    }
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto">
      <section className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
        <p className="mt-2 text-sm text-neutral-400">
          平台總覽 · 每 15 秒自動刷新
        </p>
      </section>

      {error && (
        <p className="text-sm text-[var(--accent-red)] mb-4" data-testid="dashboard-error">
          錯誤：{error}
        </p>
      )}

      {/* ── Metric cards ── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8" data-testid="dashboard-metrics">
        <MetricCard label="載具總數" value={data?.vehicleCount} testid="metric-vehicles" />
        <MetricCard label="使用者總數" value={data?.userCount} testid="metric-users" />
        <MetricCard
          label="24h Audit 事件"
          value={data?.recentAuditCount}
          testid="metric-audit"
        />
      </div>

      {/* ── Quick actions ── */}
      <div className="flex flex-wrap gap-3 mb-8" data-testid="dashboard-actions">
        <Button
          variant="secondary"
          size="md"
          onClick={() => router.push("/admin/vehicles/new")}
          data-testid="action-add-vehicle"
        >
          + 加車
        </Button>
        <Button
          variant="secondary"
          size="md"
          onClick={() => router.push("/admin/users/new")}
          data-testid="action-add-user"
        >
          + 加使用者
        </Button>
        <Button
          variant="ghost"
          size="md"
          onClick={() => router.push("/admin/audit")}
          data-testid="action-view-audit"
        >
          查 Audit →
        </Button>
      </div>

      {/* ── Recent audit events ── */}
      <section>
        <h2 className="text-lg font-semibold tracking-tight mb-3">最近 Audit 事件</h2>
        <Card className="p-4 sm:p-5">
          {data === null ? (
            <p className="text-sm text-neutral-500">載入中…</p>
          ) : data.recentEvents.length === 0 ? (
            <p className="text-sm text-neutral-500">
              尚無 audit 事件 — 之後的 admin 操作（加車 / 加使用者 / 權限變更）會出現在這裡
            </p>
          ) : (
            <ol className="space-y-0" data-testid="dashboard-timeline">
              {data.recentEvents.map((e, i) => (
                <TimelineRow
                  key={e.id}
                  event={e}
                  isLast={i === data.recentEvents.length - 1}
                />
              ))}
            </ol>
          )}
        </Card>
      </section>
    </div>
  );
}

function MetricCard({
  label,
  value,
  testid,
}: {
  label: string;
  value: number | undefined;
  testid: string;
}) {
  return (
    <Card className="p-5" data-testid={testid}>
      <p className="text-xs uppercase tracking-[0.16em] text-neutral-500">{label}</p>
      <p className="mt-2 text-4xl font-semibold tabular-nums tracking-tight">
        {value ?? "—"}
      </p>
    </Card>
  );
}

function TimelineRow({ event, isLast }: { event: AdminAuditEvent; isLast: boolean }) {
  return (
    <li className="flex gap-3">
      {/* timeline gutter */}
      <div className="flex flex-col items-center">
        <span className="mt-1.5 w-2 h-2 rounded-full bg-[var(--accent-blue)] shrink-0" />
        {!isLast && <span className="flex-1 w-px bg-[var(--border-strong)]" />}
      </div>
      <div className={`min-w-0 ${isLast ? "" : "pb-4"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="px-2 py-0.5 rounded-md border border-[var(--border-strong)] bg-white/5 text-xs font-mono text-neutral-200">
            {event.eventName}
          </span>
          {event.targetType && (
            <span className="text-xs text-neutral-500">
              {event.targetType}
              {event.targetId ? ` · ${event.targetId}` : ""}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-neutral-500 font-mono">
          {new Date(event.ts).toLocaleString("zh-TW", { hour12: false })}
          {event.actorId ? ` · by ${event.actorId}` : ""}
        </p>
      </div>
    </li>
  );
}
