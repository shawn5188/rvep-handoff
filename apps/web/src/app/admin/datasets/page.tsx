"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  listDatasets,
  listVehicles,
  ApiError,
  DatasetAsset,
  Vehicle,
} from "@/lib/api-client";

/**
 * Phase 1 dataset asset list — every metadata.jsonl / video chunk an Edge
 * Agent reports via /api/v1/internal/dataset-asset shows up here.
 * Rendered inside the c15 P2 admin shell (app/admin/layout.tsx) which
 * provides sidebar / breadcrumb / user menu — no page-level header needed.
 */
export default function DatasetsPage() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [filter, setFilter] = useState<string>("");
  const [assets, setAssets] = useState<DatasetAsset[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listVehicles()
      .then(setVehicles)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
        }
      });
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await listDatasets(filter || undefined, 200);
        if (!cancelled) setAssets(data);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.code : "network_error");
      }
    }
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [filter, router]);

  return (
    <div className="max-w-6xl mx-auto">
      <section className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">Dataset 資料</h1>
        <p className="mt-2 text-sm text-neutral-400">
          所有 metadata.jsonl / 影像錄製 / annotated 輸出（Phase 1 本地寫入；Phase 2 自動同步）
        </p>
      </section>

      <div className="mb-4 flex items-center gap-3">
        <label htmlFor="vehicle-filter" className="text-sm text-neutral-400">
          車輛
        </label>
        <select
          id="vehicle-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="px-3 py-1.5 rounded-md bg-black/40 border border-[var(--border-subtle)] text-sm text-neutral-200"
          data-testid="dataset-filter"
        >
          <option value="">所有車輛</option>
          {vehicles.map((v) => (
            <option key={v.vehicleId} value={v.vehicleId}>
              {v.displayName} ({v.vehicleId})
            </option>
          ))}
        </select>
        <span className="text-xs text-neutral-500">每 10 秒自動刷新</span>
      </div>

      {error && (
        <p className="text-sm text-[var(--accent-red)] mb-4" data-testid="dataset-error">
          錯誤：{error}
        </p>
      )}

      {assets === null ? (
        <p className="text-sm text-neutral-500">載入中…</p>
      ) : assets.length === 0 ? (
        <p className="text-sm text-neutral-500">無資料</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border-subtle)]">
          <table className="w-full text-sm" data-testid="dataset-table">
            <thead className="bg-black/40 text-neutral-400 text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2 font-medium">時間</th>
                <th className="text-left px-3 py-2 font-medium">車輛</th>
                <th className="text-left px-3 py-2 font-medium">Session</th>
                <th className="text-left px-3 py-2 font-medium">類型</th>
                <th className="text-left px-3 py-2 font-medium">大小</th>
                <th className="text-left px-3 py-2 font-medium">時長</th>
                <th className="text-left px-3 py-2 font-medium">同步</th>
                <th className="text-left px-3 py-2 font-medium">路徑</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr
                  key={a.id}
                  className="border-t border-[var(--border-subtle)] hover:bg-white/5 transition"
                >
                  <td className="px-3 py-2 text-neutral-300 font-mono whitespace-nowrap">
                    {new Date(a.createdAt).toLocaleString("zh-TW", { hour12: false })}
                  </td>
                  <td className="px-3 py-2 text-neutral-300">{a.vehicleId}</td>
                  <td className="px-3 py-2 text-neutral-400 font-mono text-xs">
                    {a.sessionId.slice(0, 8)}…
                  </td>
                  <td className="px-3 py-2">
                    <KindBadge kind={a.kind} />
                  </td>
                  <td className="px-3 py-2 text-neutral-300 tabular-nums">
                    {a.sizeBytes != null ? formatBytes(a.sizeBytes) : "—"}
                  </td>
                  <td className="px-3 py-2 text-neutral-300 tabular-nums">
                    {a.durationMs != null ? formatDuration(a.durationMs) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    {a.syncedAt ? (
                      <span className="text-emerald-300">已同步</span>
                    ) : (
                      <span className="text-neutral-500">本地</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-neutral-500 font-mono text-xs truncate max-w-md">
                    {a.path}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  const tone =
    kind === "RAW"
      ? "bg-blue-500/15 text-blue-300 border-blue-500/30"
      : kind === "ANNOTATED"
        ? "bg-purple-500/15 text-purple-300 border-purple-500/30"
        : kind === "METADATA"
          ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
          : "bg-neutral-500/15 text-neutral-300 border-neutral-500/30";
  return (
    <span className={`px-2 py-0.5 rounded-md border text-xs font-mono ${tone}`}>
      {kind}
    </span>
  );
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)} 分 ${Math.floor(s % 60)} 秒`;
  return `${Math.floor(m / 60)} 時 ${Math.floor(m % 60)} 分`;
}
