"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  adminArchiveVehicle,
  adminDownloadDeployPackage,
  adminListVehicles,
  adminMintVehicleToken,
  AdminVehicle,
  ApiError,
} from "@/lib/api-client";
import { saveBlob } from "@/lib/download";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { StatusBadge } from "@/components/admin/StatusBadge";

/**
 * c15 P3 — /admin/vehicles: fleet-wide vehicle list.
 * Desktop (md+): dense sortable table (engineer UX).
 * Mobile: card list (vendor UX), 44px+ touch targets.
 */

type SortKey = "vehicleId" | "displayName" | "vehicleType" | "adapterType" | "status" | "vendor";

export default function AdminVehiclesPage() {
  const router = useRouter();
  const [vehicles, setVehicles] = useState<AdminVehicle[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("vehicleId");
  const [sortAsc, setSortAsc] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<AdminVehicle | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await adminListVehicles(includeArchived);
      setVehicles(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "network_error");
    }
  }, [includeArchived]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const visible = useMemo(() => {
    if (!vehicles) return null;
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? vehicles.filter((v) =>
          [v.vehicleId, v.displayName, v.vehicleType, v.adapterType, v.vendor ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
      : vehicles;
    const dir = sortAsc ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = (a[sortKey] ?? "") as string;
      const bv = (b[sortKey] ?? "") as string;
      return av.localeCompare(bv) * dir;
    });
  }, [vehicles, filter, sortKey, sortAsc]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  async function onDownload(v: AdminVehicle) {
    setBusyId(v.vehicleId);
    try {
      const blob = await adminDownloadDeployPackage(v.vehicleId);
      saveBlob(blob, `${v.vehicleId}-deploy.tar.gz`);
      setNotice(`已下載 ${v.vehicleId} 部署套件（含新簽 token）`);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "download_failed");
    } finally {
      setBusyId(null);
    }
  }

  async function onMintToken(v: AdminVehicle) {
    setBusyId(v.vehicleId);
    try {
      const minted = await adminMintVehicleToken(v.vehicleId);
      await navigator.clipboard.writeText(minted.token).catch(() => undefined);
      setNotice(
        `已重簽 ${v.vehicleId} token（24h，已複製到剪貼簿），到期 ${new Date(
          minted.expiresAt,
        ).toLocaleString("zh-TW", { hour12: false })}`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "token_failed");
    } finally {
      setBusyId(null);
    }
  }

  async function onConfirmArchive() {
    if (!archiveTarget) return;
    const v = archiveTarget;
    setArchiveTarget(null);
    setBusyId(v.vehicleId);
    try {
      await adminArchiveVehicle(v.vehicleId);
      setNotice(`已封存 ${v.vehicleId}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "archive_failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-6xl mx-auto">
      <section className="mb-6 flex flex-wrap items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight">Vehicles</h1>
          <p className="mt-2 text-sm text-neutral-400">
            載具管理 · 每 15 秒自動刷新
          </p>
        </div>
        <div className="ml-auto">
          <Button
            size="md"
            onClick={() => router.push("/admin/vehicles/new")}
            data-testid="add-vehicle-btn"
          >
            + 加新車
          </Button>
        </div>
      </section>

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜尋 id / 名稱 / adapter / vendor…"
          data-testid="vehicle-filter"
          className="flex-1 min-w-[200px] max-w-sm rounded-xl bg-black/40 border border-[var(--border-subtle)] px-4 h-11 text-sm outline-none focus:border-white/30 transition-colors placeholder-neutral-600"
        />
        <label className="inline-flex items-center gap-2 min-h-11 px-2 text-sm text-neutral-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="accent-[var(--accent-blue)] w-4 h-4"
            data-testid="include-archived-toggle"
          />
          顯示已封存
        </label>
      </div>

      {error && (
        <p className="text-sm text-[var(--accent-red)] mb-4" data-testid="vehicles-error">
          錯誤：{error}
        </p>
      )}
      {notice && (
        <p
          className="text-sm text-emerald-300 mb-4"
          data-testid="vehicles-notice"
          onClick={() => setNotice(null)}
        >
          ✅ {notice}
        </p>
      )}

      {visible === null ? (
        <p className="text-sm text-neutral-500">載入中…</p>
      ) : visible.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-neutral-500" data-testid="vehicles-empty">
            {filter ? "沒有符合的載具" : "尚無載具 — 點右上「+ 加新車」開始"}
          </p>
        </Card>
      ) : (
        <>
          {/* ── Desktop dense table ── */}
          <Card className="hidden md:block overflow-x-auto p-0">
            <table className="w-full text-sm" data-testid="vehicles-table">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] text-left">
                  <Th label="Vehicle ID" k="vehicleId" sortKey={sortKey} asc={sortAsc} onSort={toggleSort} />
                  <Th label="名稱" k="displayName" sortKey={sortKey} asc={sortAsc} onSort={toggleSort} />
                  <Th label="類型" k="vehicleType" sortKey={sortKey} asc={sortAsc} onSort={toggleSort} />
                  <Th label="Adapter" k="adapterType" sortKey={sortKey} asc={sortAsc} onSort={toggleSort} />
                  <Th label="狀態" k="status" sortKey={sortKey} asc={sortAsc} onSort={toggleSort} />
                  <Th label="Vendor" k="vendor" sortKey={sortKey} asc={sortAsc} onSort={toggleSort} />
                  <th className="px-4 py-3 font-medium text-neutral-500 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((v) => (
                  <tr
                    key={v.vehicleId}
                    className={`border-b border-[var(--border-subtle)] last:border-0 hover:bg-white/[0.03] transition-colors ${
                      v.archivedAt ? "opacity-50" : ""
                    }`}
                    data-testid={`vehicle-row-${v.vehicleId}`}
                  >
                    <td className="px-4 py-2.5 font-mono">
                      <Link
                        href={`/admin/vehicles/${encodeURIComponent(v.vehicleId)}`}
                        className="text-[var(--accent-blue)] hover:underline"
                      >
                        {v.vehicleId}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">{v.displayName}</td>
                    <td className="px-4 py-2.5 text-neutral-400">{v.vehicleType}</td>
                    <td className="px-4 py-2.5 font-mono text-neutral-400">{v.adapterType}</td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={v.status} archived={v.archivedAt !== null} />
                    </td>
                    <td className="px-4 py-2.5 text-neutral-400">{v.vendor ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <RowActions
                        vehicle={v}
                        busy={busyId === v.vehicleId}
                        onEdit={() => router.push(`/admin/vehicles/${encodeURIComponent(v.vehicleId)}`)}
                        onDownload={() => onDownload(v)}
                        onMintToken={() => onMintToken(v)}
                        onArchive={() => setArchiveTarget(v)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* ── Mobile card list ── */}
          <div className="md:hidden space-y-3" data-testid="vehicles-cards">
            {visible.map((v) => (
              <Card
                key={v.vehicleId}
                className={`p-4 ${v.archivedAt ? "opacity-60" : ""}`}
                data-testid={`vehicle-card-${v.vehicleId}`}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/admin/vehicles/${encodeURIComponent(v.vehicleId)}`}
                      className="block font-mono text-[var(--accent-blue)] truncate"
                    >
                      {v.vehicleId}
                    </Link>
                    <p className="mt-0.5 text-sm text-neutral-200 truncate">{v.displayName}</p>
                    <p className="mt-1 text-xs text-neutral-500">
                      {v.vehicleType} · {v.adapterType}
                      {v.vendor ? ` · ${v.vendor}` : ""}
                    </p>
                  </div>
                  <StatusBadge status={v.status} archived={v.archivedAt !== null} />
                </div>
                <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]">
                  <RowActions
                    vehicle={v}
                    busy={busyId === v.vehicleId}
                    onEdit={() => router.push(`/admin/vehicles/${encodeURIComponent(v.vehicleId)}`)}
                    onDownload={() => onDownload(v)}
                    onMintToken={() => onMintToken(v)}
                    onArchive={() => setArchiveTarget(v)}
                  />
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* ── Archive confirm modal ── */}
      {archiveTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <button
            aria-label="取消"
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setArchiveTarget(null)}
          />
          <Card className="relative w-full max-w-sm p-6" data-testid="archive-modal">
            <h2 className="text-lg font-semibold">封存 {archiveTarget.vehicleId}？</h2>
            <p className="mt-2 text-sm text-neutral-400">
              封存後不會出現在 Fleet / 預設列表，但歷史 session 與 audit 紀錄保留，可隨時查閱。
            </p>
            <div className="mt-5 flex gap-3 justify-end">
              <Button variant="ghost" size="md" onClick={() => setArchiveTarget(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                size="md"
                onClick={onConfirmArchive}
                data-testid="archive-confirm-btn"
              >
                封存
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function Th({
  label,
  k,
  sortKey,
  asc,
  onSort,
}: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  asc: boolean;
  onSort: (k: SortKey) => void;
}) {
  const active = k === sortKey;
  return (
    <th className="px-4 py-3 font-medium text-neutral-500">
      <button
        onClick={() => onSort(k)}
        className={`inline-flex items-center gap-1 hover:text-neutral-200 transition-colors ${
          active ? "text-neutral-200" : ""
        }`}
      >
        {label}
        {active && <span className="text-[10px]">{asc ? "▲" : "▼"}</span>}
      </button>
    </th>
  );
}

function RowActions({
  vehicle,
  busy,
  onEdit,
  onDownload,
  onMintToken,
  onArchive,
}: {
  vehicle: AdminVehicle;
  busy: boolean;
  onEdit: () => void;
  onDownload: () => void;
  onMintToken: () => void;
  onArchive: () => void;
}) {
  const archived = vehicle.archivedAt !== null;
  const action =
    "inline-flex items-center min-h-11 md:min-h-8 px-2.5 rounded-lg text-xs " +
    "text-neutral-400 hover:text-white hover:bg-white/5 transition-colors " +
    "disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap";
  return (
    <div className="flex flex-wrap gap-1 md:justify-end">
      <button onClick={onEdit} disabled={busy} className={action} data-testid="row-edit">
        編輯
      </button>
      <button
        onClick={onDownload}
        disabled={busy || archived}
        className={action}
        data-testid="row-download"
      >
        部署套件
      </button>
      <button
        onClick={onMintToken}
        disabled={busy || archived}
        className={action}
        data-testid="row-token"
      >
        重簽 Token
      </button>
      <button
        onClick={onArchive}
        disabled={busy || archived}
        className={`${action} hover:text-[var(--accent-red)]`}
        data-testid="row-archive"
      >
        封存
      </button>
    </div>
  );
}
