"use client";

import { useState } from "react";
import type { RoleName } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

/**
 * c15 P5 — editor for a single user × vehicle permission cell.
 * Rendered as a centered modal (works as the grid "popover" on desktop and
 * as the touch editor on mobile). Role `null` = no permission.
 * priorityOverride `null` = role default (per c14: ADMIN 100 / OPERATOR 50 /
 * VIEWER 0).
 */

export interface CellValue {
  role: RoleName | null;
  priorityOverride: number | null;
}

export const ROLE_DEFAULT_PRIORITY: Record<RoleName, number> = {
  ADMIN: 100,
  OPERATOR: 50,
  VIEWER: 0,
};

const ROLE_OPTIONS: Array<{ value: RoleName | null; label: string }> = [
  { value: null, label: "— 無權限" },
  { value: "VIEWER", label: "VIEWER" },
  { value: "OPERATOR", label: "OPERATOR" },
  { value: "ADMIN", label: "ADMIN" },
];

export function PermissionCell({
  userEmail,
  userRole,
  vehicleLabel,
  value,
  onApply,
  onClose,
}: {
  userEmail: string;
  /** Target user's global role — per-vehicle ADMIN is only valid for global ADMINs. */
  userRole: RoleName;
  vehicleLabel: string;
  value: CellValue;
  onApply: (next: CellValue) => void;
  onClose: () => void;
}) {
  const [role, setRole] = useState<RoleName | null>(value.role);
  const [useDefault, setUseDefault] = useState(value.priorityOverride === null);
  const [priority, setPriority] = useState(
    value.priorityOverride ?? (value.role ? ROLE_DEFAULT_PRIORITY[value.role] : 50),
  );

  const adminBlocked = userRole !== "ADMIN";

  function apply() {
    onApply({
      role,
      priorityOverride: role === null || useDefault ? null : priority,
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <button
        aria-label="取消"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <Card className="relative w-full max-w-sm p-6" data-testid="permission-cell-modal">
        <h2 className="text-base font-semibold font-mono truncate">{vehicleLabel}</h2>
        <p className="mt-1 text-sm text-neutral-400 truncate">{userEmail}</p>

        {/* ── Role ── */}
        <div className="mt-5">
          <p className="text-xs text-neutral-500 mb-2">角色</p>
          <div className="grid grid-cols-2 gap-2">
            {ROLE_OPTIONS.map((opt) => {
              const disabled = opt.value === "ADMIN" && adminBlocked;
              const active = role === opt.value;
              return (
                <button
                  key={opt.label}
                  onClick={() => !disabled && setRole(opt.value)}
                  disabled={disabled}
                  data-testid={`cell-role-${opt.value ?? "none"}`}
                  className={`min-h-11 px-3 rounded-xl border text-sm font-mono transition-colors ${
                    active
                      ? "border-[var(--accent-blue)] bg-[var(--accent-blue)]/15 text-white"
                      : "border-[var(--border-subtle)] text-neutral-400 hover:text-white hover:border-white/30"
                  } disabled:opacity-30 disabled:cursor-not-allowed`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          {adminBlocked && (
            <p className="mt-2 text-[11px] text-neutral-600">
              使用者全域角色是 {userRole} — 要給 ADMIN 請先到 Users 頁改角色
            </p>
          )}
        </div>

        {/* ── Priority override（c14 pre-emption）── */}
        {role !== null && (
          <div className="mt-5" data-testid="cell-priority-section">
            <p className="text-xs text-neutral-500 mb-2">
              優先權（搶接判定用，數字大的可搶接）
            </p>
            <label className="inline-flex items-center gap-2 min-h-11 text-sm text-neutral-300 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useDefault}
                onChange={(e) => setUseDefault(e.target.checked)}
                className="accent-[var(--accent-blue)] w-4 h-4"
                data-testid="cell-priority-default"
              />
              用角色預設（{ROLE_DEFAULT_PRIORITY[role]}）
            </label>
            {!useDefault && (
              <div className="mt-2 flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={priority}
                  onChange={(e) => setPriority(Number(e.target.value))}
                  className="flex-1 accent-amber-400"
                  data-testid="cell-priority-slider"
                />
                <span className="w-12 text-right font-mono text-amber-300 text-sm">
                  +{priority}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex gap-3 justify-end">
          <Button variant="ghost" size="md" onClick={onClose}>
            取消
          </Button>
          <Button size="md" onClick={apply} data-testid="cell-apply-btn">
            套用
          </Button>
        </div>
      </Card>
    </div>
  );
}
