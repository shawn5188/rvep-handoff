"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  adminGetUserPermissions,
  adminListUsers,
  adminPutUserPermissions,
  AdminUser,
  AdminUserPermissions,
  ApiError,
  getMe,
  PermissionWrite,
  RoleName,
} from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { RoleBadge } from "@/components/admin/RoleBadge";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ROLE_DEFAULT_PRIORITY } from "@/components/admin/PermissionCell";

/**
 * c15 P5 — /admin/permissions/[userId]: single-user permission editor.
 * Entered from /admin/users/[id] 權限 tab or a matrix row. Edits are local
 * until 儲存 (one PUT full-replace). Includes 複製自其他 user and
 * 重設為 role default (priorityOverride → null) shortcuts.
 */

interface DraftRow {
  vehicleId: string;
  role: RoleName;
  priorityOverride: number | null;
}

const ERROR_MESSAGES: Record<string, string> = {
  cannot_edit_own_permissions: "不能編輯自己的權限（需另一位 admin 操作）",
  cannot_grant_admin_to_non_admin:
    "不能給非 ADMIN 使用者載具 ADMIN 權限 — 請先到 Users 頁調整角色",
  user_archived: "使用者已封存，請先還原",
  unknown_vehicle: "有載具不存在或已封存，請重新整理",
  user_not_found: "找不到這個使用者",
};

function toDraft(data: AdminUserPermissions): DraftRow[] {
  return data.permissions.map((p) => ({
    vehicleId: p.vehicleId,
    role: p.role,
    priorityOverride: p.priorityOverride,
  }));
}

function sameDraft(a: DraftRow[], b: DraftRow[]): boolean {
  if (a.length !== b.length) return false;
  const key = (r: DraftRow) => `${r.vehicleId}:${r.role}:${r.priorityOverride}`;
  const setB = new Set(b.map(key));
  return a.every((r) => setB.has(key(r)));
}

export default function UserPermissionsPage() {
  const params = useParams<{ userId: string }>();
  const userId = decodeURIComponent(params.userId);
  const router = useRouter();

  const [data, setData] = useState<AdminUserPermissions | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copySource, setCopySource] = useState("");

  const load = useCallback(async () => {
    try {
      const [d, list, me] = await Promise.all([
        adminGetUserPermissions(userId),
        adminListUsers(),
        getMe(),
      ]);
      setData(d);
      setDraft(toDraft(d));
      setUsers(list);
      setMeId(me.userId);
      setError(null);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "network_error";
      setError(ERROR_MESSAGES[code] ?? code);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  // vehicleId → display info, spanning granted + available vehicles.
  const vehicleInfo = useMemo(() => {
    const map = new Map<
      string,
      { externalId: string; displayName: string; status: string }
    >();
    if (data) {
      for (const p of data.permissions) {
        map.set(p.vehicleId, {
          externalId: p.vehicleExternalId,
          displayName: p.vehicleDisplayName,
          status: p.vehicleStatus,
        });
      }
      for (const v of data.availableVehicles) {
        map.set(v.vehicleId, {
          externalId: v.vehicleExternalId,
          displayName: v.displayName,
          status: v.status,
        });
      }
    }
    return map;
  }, [data]);

  const dirty = useMemo(
    () => (data ? !sameDraft(draft, toDraft(data)) : false),
    [draft, data],
  );
  const readOnly = data !== null && meId !== null && data.userId === meId;
  const adminBlocked = data !== null && data.userRole !== "ADMIN";

  const draftedIds = useMemo(() => new Set(draft.map((r) => r.vehicleId)), [draft]);
  const addableVehicles = useMemo(
    () => [...vehicleInfo.keys()].filter((id) => !draftedIds.has(id)),
    [vehicleInfo, draftedIds],
  );

  function updateRow(vehicleId: string, patch: Partial<DraftRow>) {
    setDraft((rows) =>
      rows.map((r) => (r.vehicleId === vehicleId ? { ...r, ...patch } : r)),
    );
  }

  async function onCopyFrom() {
    if (!copySource) return;
    try {
      const source = await adminGetUserPermissions(copySource);
      let skippedAdmin = 0;
      const rows: DraftRow[] = [];
      for (const p of source.permissions) {
        if (!vehicleInfo.has(p.vehicleId)) continue;
        if (p.role === "ADMIN" && adminBlocked) {
          skippedAdmin += 1;
          continue;
        }
        rows.push({
          vehicleId: p.vehicleId,
          role: p.role,
          priorityOverride: p.priorityOverride,
        });
      }
      setDraft(rows);
      setNotice(
        `已複製 ${source.userEmail} 的 ${rows.length} 筆權限（尚未儲存）` +
          (skippedAdmin > 0 ? `，略過 ${skippedAdmin} 筆 ADMIN（目標使用者非 ADMIN）` : ""),
      );
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "copy_failed";
      setError(ERROR_MESSAGES[code] ?? code);
    }
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      const permissions: PermissionWrite[] = draft.map((r) => ({
        vehicleId: r.vehicleId,
        role: r.role,
        priorityOverride: r.priorityOverride,
      }));
      const updated = await adminPutUserPermissions(userId, permissions);
      setData(updated);
      setDraft(toDraft(updated));
      setNotice("已儲存權限變更");
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "save_failed";
      setError(ERROR_MESSAGES[code] ?? code);
    } finally {
      setSaving(false);
    }
  }

  if (error && !data) {
    return (
      <div className="max-w-4xl mx-auto">
        <p className="text-sm text-[var(--accent-red)]" data-testid="user-perms-error">
          {error}
        </p>
        <Button
          variant="secondary"
          size="md"
          className="mt-4"
          onClick={() => router.push("/admin/permissions")}
        >
          ← 回權限矩陣
        </Button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="max-w-4xl mx-auto space-y-3" data-testid="user-perms-skeleton">
        <div className="h-9 w-64 rounded-lg bg-white/5 animate-pulse" />
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-16 w-full rounded-2xl bg-white/5 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* ── Header ── */}
      <Card className="p-5 sm:p-6 mb-6" data-testid="user-perms-header">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight font-mono truncate">
            {data.userEmail}
          </h1>
          <RoleBadge role={data.userRole} />
        </div>
        <p className="mt-1 text-sm text-neutral-400">
          {data.userDisplayName ?? "—"} · 載具權限編輯（含 c14 優先權）
        </p>
        {readOnly && (
          <p className="mt-3 text-sm text-amber-300" data-testid="self-edit-banner">
            這是你自己的帳號 — 權限需由另一位 admin 修改（唯讀）。
          </p>
        )}
      </Card>

      {error && (
        <p
          className="text-sm text-[var(--accent-red)] mb-4 cursor-pointer"
          onClick={() => setError(null)}
          data-testid="user-perms-error"
        >
          錯誤：{error}
        </p>
      )}
      {notice && (
        <p
          className="text-sm text-emerald-300 mb-4 cursor-pointer"
          onClick={() => setNotice(null)}
          data-testid="user-perms-notice"
        >
          ✅ {notice}
        </p>
      )}

      {/* ── Shortcuts ── */}
      {!readOnly && (
        <Card className="p-4 sm:p-5 mb-4">
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={copySource}
              onChange={(e) => setCopySource(e.target.value)}
              data-testid="copy-source-select"
              className="min-h-11 flex-1 min-w-[200px] max-w-sm rounded-xl bg-black/40 border border-[var(--border-subtle)] px-3 text-sm text-neutral-300 outline-none focus:border-white/30"
            >
              <option value="">複製自其他 user…</option>
              {users
                .filter((u) => u.id !== data.userId)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.email}（{u.role}）
                  </option>
                ))}
            </select>
            <Button
              variant="secondary"
              size="md"
              onClick={onCopyFrom}
              disabled={!copySource || saving}
              data-testid="copy-from-btn"
            >
              複製
            </Button>
            <Button
              variant="ghost"
              size="md"
              onClick={() => {
                setDraft((rows) => rows.map((r) => ({ ...r, priorityOverride: null })));
                setNotice("已將所有優先權重設為 role 預設（尚未儲存）");
              }}
              disabled={saving || draft.every((r) => r.priorityOverride === null)}
              data-testid="reset-priority-btn"
            >
              重設為 role default
            </Button>
          </div>
        </Card>
      )}

      {/* ── Permission rows ── */}
      <Card className="p-4 sm:p-5" data-testid="user-perms-list">
        {draft.length === 0 ? (
          <p className="text-sm text-neutral-500 py-2">
            尚未指派任何載具權限 — 用下方「加載具」開始
          </p>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            {draft.map((row) => {
              const info = vehicleInfo.get(row.vehicleId);
              return (
                <li
                  key={row.vehicleId}
                  className="py-3 flex flex-wrap items-center gap-x-4 gap-y-2"
                  data-testid={`perm-row-${row.vehicleId}`}
                >
                  <div className="min-w-0 w-full sm:w-48">
                    <p className="font-mono text-sm text-neutral-200 truncate">
                      {info?.externalId ?? row.vehicleId}
                    </p>
                    <p className="text-xs text-neutral-500 truncate">{info?.displayName}</p>
                    {info && <StatusBadge status={info.status} className="mt-0.5 !text-[10px]" />}
                  </div>

                  <select
                    value={row.role}
                    onChange={(e) => updateRow(row.vehicleId, { role: e.target.value as RoleName })}
                    disabled={readOnly}
                    data-testid={`perm-role-${row.vehicleId}`}
                    className="min-h-11 rounded-xl bg-black/40 border border-[var(--border-subtle)] px-3 text-sm font-mono text-neutral-200 outline-none focus:border-white/30 disabled:opacity-50"
                  >
                    <option value="VIEWER">VIEWER</option>
                    <option value="OPERATOR">OPERATOR</option>
                    <option value="ADMIN" disabled={adminBlocked}>
                      ADMIN{adminBlocked ? "（需全域 ADMIN）" : ""}
                    </option>
                  </select>

                  <div className="flex items-center gap-2 flex-1 min-w-[220px]">
                    <label className="inline-flex items-center gap-1.5 text-xs text-neutral-400 cursor-pointer select-none whitespace-nowrap">
                      <input
                        type="checkbox"
                        checked={row.priorityOverride === null}
                        onChange={(e) =>
                          updateRow(row.vehicleId, {
                            priorityOverride: e.target.checked
                              ? null
                              : ROLE_DEFAULT_PRIORITY[row.role],
                          })
                        }
                        disabled={readOnly}
                        className="accent-[var(--accent-blue)] w-4 h-4"
                        data-testid={`perm-priority-default-${row.vehicleId}`}
                      />
                      預設（{ROLE_DEFAULT_PRIORITY[row.role]}）
                    </label>
                    {row.priorityOverride !== null && (
                      <>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={row.priorityOverride}
                          onChange={(e) =>
                            updateRow(row.vehicleId, {
                              priorityOverride: Number(e.target.value),
                            })
                          }
                          disabled={readOnly}
                          className="flex-1 accent-amber-400"
                          data-testid={`perm-priority-slider-${row.vehicleId}`}
                        />
                        <span className="w-10 text-right font-mono text-amber-300 text-sm">
                          +{row.priorityOverride}
                        </span>
                      </>
                    )}
                  </div>

                  {!readOnly && (
                    <button
                      onClick={() =>
                        setDraft((rows) => rows.filter((r) => r.vehicleId !== row.vehicleId))
                      }
                      className="ml-auto min-h-11 px-2.5 rounded-lg text-xs text-neutral-500 hover:text-[var(--accent-red)] hover:bg-white/5 transition-colors"
                      data-testid={`perm-remove-${row.vehicleId}`}
                    >
                      移除
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {/* ── Add vehicle ── */}
        {!readOnly && addableVehicles.length > 0 && (
          <div className="mt-4 pt-4 border-t border-[var(--border-subtle)]">
            <select
              value=""
              onChange={(e) => {
                if (!e.target.value) return;
                setDraft((rows) => [
                  ...rows,
                  { vehicleId: e.target.value, role: "VIEWER", priorityOverride: null },
                ]);
              }}
              data-testid="add-vehicle-select"
              className="min-h-11 w-full max-w-sm rounded-xl bg-black/40 border border-[var(--border-subtle)] px-3 text-sm text-neutral-300 outline-none focus:border-white/30"
            >
              <option value="">+ 加載具…</option>
              {addableVehicles.map((id) => {
                const info = vehicleInfo.get(id)!;
                return (
                  <option key={id} value={id}>
                    {info.externalId} · {info.displayName}
                  </option>
                );
              })}
            </select>
          </div>
        )}
      </Card>

      {/* ── Save / Cancel ── */}
      {!readOnly && (
        <div className="mt-5 flex gap-3 justify-end">
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              setDraft(toDraft(data));
              setNotice(null);
            }}
            disabled={!dirty || saving}
            data-testid="perms-cancel-btn"
          >
            取消
          </Button>
          <Button
            size="md"
            onClick={onSave}
            disabled={!dirty || saving}
            data-testid="perms-save-btn"
          >
            {saving ? "儲存中…" : "儲存"}
          </Button>
        </div>
      )}
    </div>
  );
}
