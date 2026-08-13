"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  adminGetPermissionMatrix,
  adminPutUserPermissions,
  AdminPermissionMatrix,
  ApiError,
  getMe,
  PermissionWrite,
} from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { PermissionMatrixGrid } from "@/components/admin/PermissionMatrixGrid";
import { CellValue, PermissionCell } from "@/components/admin/PermissionCell";
import {
  PermissionDiffData,
  PermissionDiffPreview,
} from "@/components/admin/PermissionDiffPreview";

/**
 * c15 P5 — /admin/permissions: full user × vehicle permission matrix.
 * Cells are edited locally (dirty = amber ring) and written in one batch:
 * 「儲存所有變更」→ diff preview modal → one PUT full-replace per dirty user.
 * Integrates c14 priority pre-emption via per-cell priorityOverride.
 */

const PAGE_SIZE = 50;

const ERROR_MESSAGES: Record<string, string> = {
  cannot_edit_own_permissions: "不能編輯自己的權限（需另一位 admin 操作）",
  cannot_grant_admin_to_non_admin:
    "不能給非 ADMIN 使用者載具 ADMIN 權限 — 請先到 Users 頁調整角色",
  user_archived: "使用者已封存，請先還原",
  unknown_vehicle: "有載具不存在或已封存，請重新整理",
};

const EMPTY_CELL: CellValue = { role: null, priorityOverride: null };

function cellKey(userId: string, vehicleId: string): string {
  return `${userId}:${vehicleId}`;
}

function sameCell(a: CellValue, b: CellValue): boolean {
  return a.role === b.role && a.priorityOverride === b.priorityOverride;
}

export default function AdminPermissionsPage() {
  const [matrix, setMatrix] = useState<AdminPermissionMatrix | null>(null);
  const [meId, setMeId] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [edits, setEdits] = useState<Record<string, CellValue>>({});
  const [editing, setEditing] = useState<{ userId: string; vehicleId: string } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);

  const [vehicleTypeFilter, setVehicleTypeFilter] = useState("");
  const [onlyGranted, setOnlyGranted] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, me] = await Promise.all([
        adminGetPermissionMatrix({ limit: PAGE_SIZE, offset }),
        getMe(),
      ]);
      setMatrix(m);
      setMeId(me.userId);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "network_error");
    }
  }, [offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Effective cell state = server + pending edits ──
  const serverCells = useMemo(() => {
    const map: Record<string, CellValue> = {};
    if (matrix) {
      for (const p of matrix.permissions) {
        map[cellKey(p.userId, p.vehicleId)] = {
          role: p.role,
          priorityOverride: p.priorityOverride,
        };
      }
    }
    return map;
  }, [matrix]);

  const getCell = useCallback(
    (userId: string, vehicleId: string): CellValue => {
      const k = cellKey(userId, vehicleId);
      return edits[k] ?? serverCells[k] ?? EMPTY_CELL;
    },
    [edits, serverCells],
  );

  const isDirty = useCallback(
    (userId: string, vehicleId: string) => cellKey(userId, vehicleId) in edits,
    [edits],
  );

  function setCell(userId: string, vehicleId: string, next: CellValue) {
    const k = cellKey(userId, vehicleId);
    const server = serverCells[k] ?? EMPTY_CELL;
    setEdits((prev) => {
      const out = { ...prev };
      if (sameCell(next, server)) delete out[k];
      else out[k] = next;
      return out;
    });
  }

  const dirtyCount = Object.keys(edits).length;

  // ── Filters（display only — saving always uses the full vehicle universe）──
  const vehicleTypes = useMemo(
    () => [...new Set((matrix?.vehicles ?? []).map((v) => v.vehicleType))].sort(),
    [matrix],
  );
  const visibleVehicles = useMemo(() => {
    if (!matrix) return [];
    return vehicleTypeFilter
      ? matrix.vehicles.filter((v) => v.vehicleType === vehicleTypeFilter)
      : matrix.vehicles;
  }, [matrix, vehicleTypeFilter]);
  const visibleUsers = useMemo(() => {
    if (!matrix) return [];
    if (!onlyGranted) return matrix.users;
    return matrix.users.filter((u) =>
      matrix.vehicles.some((v) => getCell(u.userId, v.vehicleId).role !== null),
    );
  }, [matrix, onlyGranted, getCell]);

  // ── Diff for the preview modal ──
  const diff = useMemo((): PermissionDiffData => {
    const out: PermissionDiffData = { added: [], removed: [], changed: [] };
    if (!matrix) return out;
    const userById = new Map(matrix.users.map((u) => [u.userId, u]));
    const vehicleById = new Map(matrix.vehicles.map((v) => [v.vehicleId, v]));
    for (const [k, next] of Object.entries(edits)) {
      const [userId, vehicleId] = k.split(":");
      const server = serverCells[k] ?? EMPTY_CELL;
      const userEmail = userById.get(userId)?.email ?? userId;
      const vehicleLabel = vehicleById.get(vehicleId)?.vehicleExternalId ?? vehicleId;
      if (server.role === null && next.role !== null) {
        out.added.push({
          userEmail,
          vehicleLabel,
          to: { role: next.role, priorityOverride: next.priorityOverride },
        });
      } else if (server.role !== null && next.role === null) {
        out.removed.push({
          userEmail,
          vehicleLabel,
          from: { role: server.role, priorityOverride: server.priorityOverride },
        });
      } else if (server.role !== null && next.role !== null) {
        out.changed.push({
          userEmail,
          vehicleLabel,
          from: { role: server.role, priorityOverride: server.priorityOverride },
          to: { role: next.role, priorityOverride: next.priorityOverride },
        });
      }
    }
    return out;
  }, [edits, serverCells, matrix]);

  async function onConfirmSave() {
    if (!matrix) return;
    setSaving(true);
    setError(null);
    const dirtyUserIds = [...new Set(Object.keys(edits).map((k) => k.split(":")[0]))];
    const userById = new Map(matrix.users.map((u) => [u.userId, u]));
    let savedUsers = 0;
    try {
      for (const userId of dirtyUserIds) {
        // Full replace: reconstruct the user's complete permission set from
        // the effective (server + edits) state over ALL vehicles.
        const permissions: PermissionWrite[] = [];
        for (const v of matrix.vehicles) {
          const cell = getCell(userId, v.vehicleId);
          if (cell.role !== null) {
            permissions.push({
              vehicleId: v.vehicleId,
              role: cell.role,
              priorityOverride: cell.priorityOverride,
            });
          }
        }
        await adminPutUserPermissions(userId, permissions);
        savedUsers += 1;
        // Prune this user's edits — they are now server state.
        setEdits((prev) => {
          const out = { ...prev };
          for (const k of Object.keys(out)) {
            if (k.startsWith(`${userId}:`)) delete out[k];
          }
          return out;
        });
      }
      setNotice(`已儲存 ${savedUsers} 位使用者的權限變更`);
      setShowPreview(false);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "save_failed";
      const failedAt = userById.get(dirtyUserIds[savedUsers])?.email ?? "";
      setError(`${ERROR_MESSAGES[code] ?? code}${failedAt ? `（${failedAt}）` : ""}`);
      setShowPreview(false);
    } finally {
      setSaving(false);
      await load();
    }
  }

  // ── Render ──
  if (error && !matrix) {
    return (
      <div className="max-w-6xl mx-auto">
        <p className="text-sm text-[var(--accent-red)]" data-testid="permissions-error">
          錯誤：{error}
        </p>
      </div>
    );
  }

  if (!matrix) {
    return (
      <div className="max-w-6xl mx-auto space-y-3" data-testid="permissions-skeleton">
        <div className="h-9 w-56 rounded-lg bg-white/5 animate-pulse" />
        <div className="h-11 w-full max-w-md rounded-xl bg-white/5 animate-pulse" />
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-16 w-full rounded-2xl bg-white/5 animate-pulse" />
        ))}
      </div>
    );
  }

  const empty = matrix.users.length === 0 || matrix.vehicles.length === 0;
  const editingUser = editing
    ? matrix.users.find((u) => u.userId === editing.userId)
    : null;
  const editingVehicle = editing
    ? matrix.vehicles.find((v) => v.vehicleId === editing.vehicleId)
    : null;

  return (
    <div className="max-w-6xl mx-auto">
      <section className="mb-6 flex flex-wrap items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight">Permissions</h1>
          <p className="mt-2 text-sm text-neutral-400">
            user × vehicle 權限矩陣 · 點 cell 編輯角色與優先權，批次儲存
          </p>
        </div>
        <div className="ml-auto">
          <Button
            size="md"
            onClick={() => setShowPreview(true)}
            disabled={dirtyCount === 0 || saving}
            data-testid="save-all-btn"
          >
            儲存所有變更{dirtyCount > 0 ? `（${dirtyCount}）` : ""}
          </Button>
        </div>
      </section>

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          value={vehicleTypeFilter}
          onChange={(e) => setVehicleTypeFilter(e.target.value)}
          data-testid="vehicle-type-filter"
          className="min-h-11 rounded-xl bg-black/40 border border-[var(--border-subtle)] px-3 text-sm text-neutral-300 outline-none focus:border-white/30"
        >
          <option value="">所有載具類型</option>
          {vehicleTypes.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-2 min-h-11 px-2 text-sm text-neutral-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={onlyGranted}
            onChange={(e) => setOnlyGranted(e.target.checked)}
            className="accent-[var(--accent-blue)] w-4 h-4"
            data-testid="only-granted-toggle"
          />
          只看有權限的 user
        </label>
        {dirtyCount > 0 && (
          <button
            onClick={() => setEdits({})}
            className="min-h-11 px-2 text-sm text-neutral-500 hover:text-white transition-colors"
            data-testid="discard-edits-btn"
          >
            捨棄未儲存變更
          </button>
        )}
      </div>

      {error && (
        <p
          className="text-sm text-[var(--accent-red)] mb-4 cursor-pointer"
          onClick={() => setError(null)}
          data-testid="permissions-error"
        >
          錯誤：{error}
        </p>
      )}
      {notice && (
        <p
          className="text-sm text-emerald-300 mb-4 cursor-pointer"
          onClick={() => setNotice(null)}
          data-testid="permissions-notice"
        >
          ✅ {notice}
        </p>
      )}

      {empty ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-neutral-500" data-testid="permissions-empty">
            還沒有 {matrix.vehicles.length === 0 ? "vehicle" : "user"} — 先去{" "}
            <Link href="/admin/vehicles" className="text-[var(--accent-blue)] hover:underline">
              /admin/vehicles
            </Link>{" "}
            或{" "}
            <Link href="/admin/users" className="text-[var(--accent-blue)] hover:underline">
              /admin/users
            </Link>{" "}
            建立
          </p>
        </Card>
      ) : (
        <PermissionMatrixGrid
          users={visibleUsers}
          vehicles={visibleVehicles}
          getCell={getCell}
          isDirty={isDirty}
          isRowDisabled={(userId) => userId === meId}
          onCellClick={(userId, vehicleId) => setEditing({ userId, vehicleId })}
        />
      )}

      {/* ── Pagination（user 軸）── */}
      {matrix.totalUsers > PAGE_SIZE && (
        <div className="mt-4 flex items-center gap-3 text-sm text-neutral-400">
          <Button
            variant="ghost"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            ← 上一頁
          </Button>
          <span className="font-mono text-xs">
            {offset + 1}-{Math.min(offset + PAGE_SIZE, matrix.totalUsers)} / {matrix.totalUsers}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={offset + PAGE_SIZE >= matrix.totalUsers}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            下一頁 →
          </Button>
        </div>
      )}

      {/* ── Cell editor ── */}
      {editing && editingUser && editingVehicle && (
        <PermissionCell
          userEmail={editingUser.email}
          userRole={editingUser.role}
          vehicleLabel={`${editingVehicle.vehicleExternalId} · ${editingVehicle.displayName}`}
          value={getCell(editing.userId, editing.vehicleId)}
          onApply={(next) => {
            setCell(editing.userId, editing.vehicleId, next);
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
        />
      )}

      {/* ── Batch diff preview ── */}
      {showPreview && (
        <PermissionDiffPreview
          diff={diff}
          saving={saving}
          onConfirm={onConfirmSave}
          onCancel={() => setShowPreview(false)}
        />
      )}
    </div>
  );
}
