"use client";

import Link from "next/link";
import type {
  AdminAvailableVehicle,
  AdminMatrixUser,
} from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { RoleBadge } from "@/components/admin/RoleBadge";
import { StatusBadge } from "@/components/admin/StatusBadge";
import type { CellValue } from "@/components/admin/PermissionCell";

/**
 * c15 P5 — shared user × vehicle permission grid.
 * Desktop (md+): dense table — row = user, col = vehicle, cell = role button.
 * Mobile: list-per-user cards with permission chips (mobile-first rule).
 * Purely presentational: effective cell state (server + pending edits) comes
 * from the parent via getCell / isDirty.
 */

const ROLE_SHORT: Record<string, string> = {
  ADMIN: "ADMIN",
  OPERATOR: "OPER",
  VIEWER: "VIEW",
};

const ROLE_TONE: Record<string, string> = {
  ADMIN: "text-[var(--accent-red)]",
  OPERATOR: "text-[var(--accent-blue)]",
  VIEWER: "text-neutral-300",
};

function CellContent({ value }: { value: CellValue }) {
  if (value.role === null) return <span className="text-neutral-600">—</span>;
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-xs ${ROLE_TONE[value.role]}`}>
      {ROLE_SHORT[value.role]}
      {value.priorityOverride !== null && (
        <span className="text-amber-300">+{value.priorityOverride}</span>
      )}
    </span>
  );
}

export function PermissionMatrixGrid({
  users,
  vehicles,
  getCell,
  isDirty,
  isRowDisabled,
  onCellClick,
}: {
  users: AdminMatrixUser[];
  vehicles: AdminAvailableVehicle[];
  getCell: (userId: string, vehicleId: string) => CellValue;
  isDirty: (userId: string, vehicleId: string) => boolean;
  /** e.g. the acting admin's own row — backend rejects self-edits. */
  isRowDisabled: (userId: string) => boolean;
  onCellClick: (userId: string, vehicleId: string) => void;
}) {
  return (
    <>
      {/* ── Desktop grid ── */}
      <Card className="hidden md:block overflow-x-auto p-0">
        <table className="w-full text-sm" data-testid="permission-matrix-table">
          <thead>
            <tr className="border-b border-[var(--border-subtle)] text-left">
              <th className="px-4 py-3 font-medium text-neutral-500 sticky left-0 bg-[var(--bg-1)] z-10">
                User
              </th>
              {vehicles.map((v) => (
                <th key={v.vehicleId} className="px-3 py-3 font-medium text-center min-w-[110px]">
                  <span className="block font-mono text-neutral-300 text-xs truncate max-w-[140px] mx-auto">
                    {v.vehicleExternalId}
                  </span>
                  <StatusBadge status={v.status} className="mt-1 !text-[10px]" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const disabled = isRowDisabled(u.userId);
              return (
                <tr
                  key={u.userId}
                  className="border-b border-[var(--border-subtle)] last:border-0 hover:bg-white/[0.02] transition-colors"
                  data-testid={`matrix-row-${u.userId}`}
                >
                  <td className="px-4 py-2 sticky left-0 bg-[var(--bg-1)] z-10">
                    <Link
                      href={`/admin/permissions/${encodeURIComponent(u.userId)}`}
                      className="block max-w-[220px] truncate text-neutral-200 hover:text-[var(--accent-blue)] transition-colors"
                    >
                      {u.email}
                    </Link>
                    <RoleBadge role={u.role} className="mt-1" />
                    {disabled && (
                      <span className="block mt-1 text-[10px] text-neutral-600">
                        （自己 — 不可編輯）
                      </span>
                    )}
                  </td>
                  {vehicles.map((v) => {
                    const value = getCell(u.userId, v.vehicleId);
                    const dirty = isDirty(u.userId, v.vehicleId);
                    return (
                      <td key={v.vehicleId} className="px-1.5 py-1.5 text-center">
                        <button
                          onClick={() => onCellClick(u.userId, v.vehicleId)}
                          disabled={disabled}
                          data-testid={`matrix-cell-${u.userId}-${v.vehicleId}`}
                          className={`inline-flex items-center justify-center min-w-[84px] min-h-9 px-2 rounded-lg border transition-colors ${
                            dirty
                              ? "border-amber-400/60 bg-amber-400/10"
                              : "border-transparent hover:border-white/20 hover:bg-white/5"
                          } disabled:opacity-40 disabled:cursor-not-allowed`}
                        >
                          <CellContent value={value} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* ── Mobile list-per-user ── */}
      <div className="md:hidden space-y-3" data-testid="permission-matrix-cards">
        {users.map((u) => {
          const disabled = isRowDisabled(u.userId);
          const granted = vehicles.filter(
            (v) => getCell(u.userId, v.vehicleId).role !== null,
          );
          const ungranted = vehicles.filter(
            (v) => getCell(u.userId, v.vehicleId).role === null,
          );
          return (
            <Card key={u.userId} className="p-4" data-testid={`matrix-card-${u.userId}`}>
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-neutral-200">{u.email}</p>
                  {u.displayName && (
                    <p className="mt-0.5 text-xs text-neutral-500 truncate">{u.displayName}</p>
                  )}
                </div>
                <RoleBadge role={u.role} />
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {granted.length === 0 && (
                  <span className="text-xs text-neutral-600">尚無任何載具權限</span>
                )}
                {granted.map((v) => {
                  const value = getCell(u.userId, v.vehicleId);
                  const dirty = isDirty(u.userId, v.vehicleId);
                  return (
                    <button
                      key={v.vehicleId}
                      onClick={() => onCellClick(u.userId, v.vehicleId)}
                      disabled={disabled}
                      data-testid={`matrix-chip-${u.userId}-${v.vehicleId}`}
                      className={`inline-flex items-center gap-1.5 min-h-9 px-2.5 rounded-lg border text-xs font-mono transition-colors ${
                        dirty
                          ? "border-amber-400/60 bg-amber-400/10"
                          : "border-[var(--border-subtle)] hover:border-white/30"
                      } disabled:opacity-40`}
                    >
                      <span className="text-neutral-400">{v.vehicleExternalId}</span>
                      <CellContent value={value} />
                    </button>
                  );
                })}
              </div>

              <div className="mt-3 pt-3 border-t border-[var(--border-subtle)] flex items-center gap-3">
                {!disabled && ungranted.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) onCellClick(u.userId, e.target.value);
                    }}
                    data-testid={`matrix-add-${u.userId}`}
                    className="min-h-9 rounded-lg bg-black/40 border border-[var(--border-subtle)] px-2 text-xs text-neutral-300 outline-none"
                  >
                    <option value="">+ 加載具權限…</option>
                    {ungranted.map((v) => (
                      <option key={v.vehicleId} value={v.vehicleId}>
                        {v.vehicleExternalId} · {v.displayName}
                      </option>
                    ))}
                  </select>
                )}
                {disabled && (
                  <span className="text-[11px] text-neutral-600">自己 — 不可編輯</span>
                )}
                <Link
                  href={`/admin/permissions/${encodeURIComponent(u.userId)}`}
                  className="ml-auto text-xs text-[var(--accent-blue)] hover:underline whitespace-nowrap"
                >
                  詳細編輯 →
                </Link>
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
