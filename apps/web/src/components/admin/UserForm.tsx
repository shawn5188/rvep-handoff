"use client";

import { z } from "zod";
import type { RoleName } from "@/lib/api-client";

/**
 * c15 P4 — shared user basic-section form, reused by:
 *   /admin/users/new    (wizard step 1)
 *   /admin/users/[id]   (基本 tab inline edit)
 * Controlled component — parent owns values / errors state (same contract as
 * VehicleForm). Client-side Zod mirrors the backend; backend re-validates.
 */

export interface UserFormValues {
  email: string;
  displayName: string;
  role: RoleName;
}

export const EMPTY_USER_FORM: UserFormValues = {
  email: "",
  displayName: "",
  role: "OPERATOR",
};

/** Role options + helper text（P5 permission matrix 決定 per-vehicle 細節）. */
export const ROLE_OPTIONS: Array<{
  value: RoleName;
  label: string;
  help: string;
}> = [
  {
    value: "ADMIN",
    label: "Admin",
    help: "完整後台權限：管理載具 / 使用者 / 權限 / audit。請謹慎授予。",
  },
  {
    value: "OPERATOR",
    label: "Operator",
    help: "可駕駛有權限的載具、取得控制 lease、查看遙測。",
  },
  {
    value: "VIEWER",
    label: "Viewer",
    help: "唯讀：只能觀看影像與遙測，不能控制。",
  },
];

export const userBasicSchema = z.object({
  email: z.string().min(1, "必填").email("Email 格式不正確").max(254),
  displayName: z.string().min(1, "必填").max(120, "最多 120 字元"),
  role: z.enum(["ADMIN", "OPERATOR", "VIEWER"]),
});

export type UserFormErrors = Partial<Record<keyof UserFormValues, string>>;

export function validateUserBasic(values: UserFormValues): UserFormErrors {
  const result = userBasicSchema.safeParse(values);
  if (result.success) return {};
  const errors: UserFormErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0] as keyof UserFormValues;
    if (!errors[key]) errors[key] = issue.message;
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

const inputClass =
  "w-full rounded-xl bg-black/40 border px-4 h-12 text-base outline-none " +
  "focus:border-white/30 transition-colors placeholder-neutral-600 " +
  "disabled:opacity-50 disabled:cursor-not-allowed";

export function UserFormFields({
  values,
  errors,
  onChange,
}: {
  values: UserFormValues;
  errors: UserFormErrors;
  onChange: (patch: Partial<UserFormValues>) => void;
}) {
  return (
    <div className="space-y-4">
      <label className="block">
        <span className="block text-xs uppercase tracking-[0.16em] text-neutral-500 mb-2">
          Email
        </span>
        <input
          type="email"
          value={values.email}
          onChange={(e) => onChange({ email: e.target.value })}
          placeholder="operator@example.com"
          autoComplete="off"
          data-testid="uf-email"
          className={`${inputClass} ${
            errors.email ? "border-[var(--accent-red)]/70" : "border-[var(--border-subtle)]"
          }`}
        />
        {errors.email && (
          <span className="block mt-1 text-xs text-[var(--accent-red)]">{errors.email}</span>
        )}
      </label>

      <label className="block">
        <span className="block text-xs uppercase tracking-[0.16em] text-neutral-500 mb-2">
          顯示名稱
        </span>
        <input
          type="text"
          value={values.displayName}
          onChange={(e) => onChange({ displayName: e.target.value })}
          placeholder="王小明"
          data-testid="uf-display-name"
          className={`${inputClass} ${
            errors.displayName
              ? "border-[var(--accent-red)]/70"
              : "border-[var(--border-subtle)]"
          }`}
        />
        {errors.displayName && (
          <span className="block mt-1 text-xs text-[var(--accent-red)]">
            {errors.displayName}
          </span>
        )}
      </label>

      <fieldset>
        <legend className="block text-xs uppercase tracking-[0.16em] text-neutral-500 mb-2">
          角色
        </legend>
        <div className="space-y-2" data-testid="uf-role">
          {ROLE_OPTIONS.map((opt) => {
            const selected = values.role === opt.value;
            return (
              <label
                key={opt.value}
                className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-colors ${
                  selected
                    ? "border-[var(--accent-blue)]/60 bg-[var(--accent-blue)]/10"
                    : "border-[var(--border-subtle)] hover:border-white/20"
                }`}
              >
                <input
                  type="radio"
                  name="user-role"
                  value={opt.value}
                  checked={selected}
                  onChange={() => onChange({ role: opt.value })}
                  className="mt-1 accent-[var(--accent-blue)]"
                  data-testid={`uf-role-${opt.value.toLowerCase()}`}
                />
                <span className="min-w-0">
                  <span
                    className={`block text-sm font-medium ${
                      selected ? "text-white" : "text-neutral-200"
                    }`}
                  >
                    {opt.label}
                  </span>
                  <span className="block mt-0.5 text-xs text-neutral-500">{opt.help}</span>
                </span>
              </label>
            );
          })}
        </div>
        {values.role === "ADMIN" && (
          <p className="mt-2 text-xs text-amber-400" data-testid="uf-admin-warning">
            ⚠ 將授予完整後台權限（含管理其他使用者）
          </p>
        )}
      </fieldset>
    </div>
  );
}
