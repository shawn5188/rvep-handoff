"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  adminCreateUser,
  adminListUsers,
  AdminUser,
  ApiError,
  CreateUserResult,
} from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { RoleBadge } from "@/components/admin/RoleBadge";
import {
  EMPTY_USER_FORM,
  UserFormErrors,
  UserFormFields,
  UserFormValues,
  validateUserBasic,
} from "@/components/admin/UserForm";
import {
  checkPasswordPolicy,
  PasswordStrengthMeter,
  POLICY_REASON_MESSAGES,
} from "@/components/admin/PasswordStrengthMeter";

/**
 * c15 P4 — /admin/users/new: 4-step create wizard.
 *   1 基本    email / displayName / role（含角色權限說明）
 *   2 密碼    invite link（預設）或 admin 手動設臨時密碼（含 strength meter）
 *   3 權限    選填 — 可跳過（P5 permission matrix 再細設）；快捷「複製既有
 *            user 權限」
 *   4 確認    summary → POST → 成功 modal 顯示 inviteLink / temporaryPassword
 *            （一次性，可複製）→ 導到 detail
 * One step per screen (mobile-first); progress bar on top.
 */

const STEPS = ["基本資料", "密碼設定", "權限（選填）", "確認建立"] as const;

const API_ERROR_MESSAGES: Record<string, string> = {
  email_taken: "這個 Email 已存在，請換一個",
  weak_password: "密碼不符合規則，請檢查",
  validation_error: "欄位驗證失敗，請檢查輸入",
  copy_source_not_found: "要複製權限的使用者不存在",
};

type InviteMethod = "email" | "manual_password";

export default function NewUserPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<UserFormValues>(EMPTY_USER_FORM);
  const [errors, setErrors] = useState<UserFormErrors>({});
  const [inviteMethod, setInviteMethod] = useState<InviteMethod>("email");
  const [manualPassword, setManualPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [copyFromId, setCopyFromId] = useState("");
  const [existingUsers, setExistingUsers] = useState<AdminUser[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreateUserResult | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    adminListUsers()
      .then(setExistingUsers)
      .catch(() => undefined); // copy-from 快捷失敗不擋 wizard
  }, []);

  function onChange(patch: Partial<UserFormValues>) {
    setValues((v) => ({ ...v, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key as keyof UserFormValues];
      return next;
    });
  }

  function next() {
    if (step === 0) {
      const errs = validateUserBasic(values);
      setErrors(errs);
      if (Object.keys(errs).length > 0) return;
    }
    if (step === 1 && inviteMethod === "manual_password") {
      const policy = checkPasswordPolicy(manualPassword);
      if (!policy.ok) {
        setPasswordError(POLICY_REASON_MESSAGES[policy.reason ?? ""] ?? "密碼不符合規則");
        return;
      }
      setPasswordError(null);
    }
    setStep((s) => s + 1);
  }

  async function onCreate() {
    setSubmitting(true);
    setApiError(null);
    try {
      const result = await adminCreateUser({
        email: values.email.trim(),
        displayName: values.displayName.trim(),
        role: values.role,
        inviteMethod,
        ...(inviteMethod === "manual_password" ? { manualPassword } : {}),
        ...(copyFromId ? { copyPermissionsFromUserId: copyFromId } : {}),
      });
      setCreated(result);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "network_error";
      setApiError(API_ERROR_MESSAGES[code] ?? `建立失敗：${code}`);
      if (code === "email_taken") setStep(0);
      if (code === "weak_password") setStep(1);
    } finally {
      setSubmitting(false);
    }
  }

  const credential = created?.inviteLink ?? created?.temporaryPassword ?? "";

  return (
    <div className="max-w-2xl mx-auto">
      <section className="mb-6">
        <h1 className="text-3xl font-semibold tracking-tight">加使用者</h1>
        <p className="mt-2 text-sm text-neutral-400">
          四步驟完成使用者上架，建立後取得邀請連結或臨時密碼
        </p>
      </section>

      {/* ── Progress ── */}
      <ol className="flex items-center gap-2 mb-6" data-testid="wizard-progress">
        {STEPS.map((label, i) => (
          <li key={label} className="flex-1">
            <div
              className={`h-1.5 rounded-full mb-2 transition-colors ${
                i <= step ? "bg-[var(--accent-blue)]" : "bg-white/10"
              }`}
            />
            <span
              className={`text-xs ${
                i === step ? "text-neutral-200 font-medium" : "text-neutral-600"
              }`}
            >
              {i + 1}. {label}
            </span>
          </li>
        ))}
      </ol>

      {apiError && (
        <p className="text-sm text-[var(--accent-red)] mb-4" data-testid="wizard-error">
          {apiError}
        </p>
      )}

      <Card className="p-5 sm:p-6">
        {step === 0 && (
          <UserFormFields values={values} errors={errors} onChange={onChange} />
        )}

        {step === 1 && (
          <div className="space-y-3" data-testid="wizard-password-step">
            <MethodOption
              selected={inviteMethod === "email"}
              onSelect={() => setInviteMethod("email")}
              title="寄邀請連結（建議）"
              testid="method-invite"
              description="產生 72 小時有效的邀請連結，由使用者自行設定密碼 — 管理員全程看不到密碼。"
            />
            <MethodOption
              selected={inviteMethod === "manual_password"}
              onSelect={() => setInviteMethod("manual_password")}
              title="手動設定臨時密碼"
              testid="method-manual"
              description="管理員直接設定一組臨時密碼，建立後顯示一次，請自行安全轉交。"
            />

            {inviteMethod === "manual_password" && (
              <div className="pt-2">
                <label className="block">
                  <span className="block text-xs uppercase tracking-[0.16em] text-neutral-500 mb-2">
                    臨時密碼
                  </span>
                  <input
                    type="text"
                    value={manualPassword}
                    onChange={(e) => {
                      setManualPassword(e.target.value);
                      setPasswordError(null);
                    }}
                    placeholder="至少 12 字元，含英文字母 + 數字"
                    autoComplete="off"
                    data-testid="wizard-manual-password"
                    className={`w-full rounded-xl bg-black/40 border px-4 h-12 text-base font-mono outline-none focus:border-white/30 transition-colors placeholder-neutral-600 ${
                      passwordError
                        ? "border-[var(--accent-red)]/70"
                        : "border-[var(--border-subtle)]"
                    }`}
                  />
                </label>
                <PasswordStrengthMeter password={manualPassword} />
                {passwordError && (
                  <p className="mt-1 text-xs text-[var(--accent-red)]">{passwordError}</p>
                )}
              </div>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4" data-testid="wizard-permission-step">
            <p className="text-sm text-neutral-400">
              權限可先留空，建立後到 <span className="text-neutral-200">Permissions</span>{" "}
              頁對每台載具細部設定；或直接複製既有使用者的載具權限：
            </p>
            <label className="block">
              <span className="block text-xs uppercase tracking-[0.16em] text-neutral-500 mb-2">
                複製既有 user 權限（選填）
              </span>
              <select
                value={copyFromId}
                onChange={(e) => setCopyFromId(e.target.value)}
                data-testid="wizard-copy-from"
                className="w-full rounded-xl bg-black/40 border border-[var(--border-subtle)] px-4 h-12 text-base outline-none appearance-none focus:border-white/30 transition-colors"
              >
                <option value="" className="bg-neutral-900">
                  — 不複製，權限留空 —
                </option>
                {existingUsers
                  .filter((u) => !u.archivedAt)
                  .map((u) => (
                    <option key={u.id} value={u.id} className="bg-neutral-900">
                      {u.email}（{u.role} · {u.activePermissionCount} 台）
                    </option>
                  ))}
              </select>
            </label>
            {copyFromId && (
              <p className="text-xs text-neutral-500">
                將以你的身分（grantedBy）複製該使用者的所有載具權限給新帳號。
              </p>
            )}
          </div>
        )}

        {step === 3 && (
          <dl
            className="space-y-0 divide-y divide-[var(--border-subtle)]"
            data-testid="wizard-summary"
          >
            <SummaryRow label="Email" value={values.email} mono />
            <SummaryRow label="顯示名稱" value={values.displayName} />
            <SummaryRow
              label="角色"
              value={<RoleBadge role={values.role} />}
            />
            <SummaryRow
              label="密碼方式"
              value={inviteMethod === "email" ? "寄邀請連結（72h 有效）" : "手動臨時密碼"}
            />
            <SummaryRow
              label="權限"
              value={
                copyFromId
                  ? `複製自 ${existingUsers.find((u) => u.id === copyFromId)?.email ?? copyFromId}`
                  : "留空（建立後再設定）"
              }
            />
          </dl>
        )}

        {/* ── Nav ── */}
        <div className="mt-6 flex gap-3">
          {step > 0 && (
            <Button
              variant="ghost"
              size="md"
              onClick={() => setStep((s) => s - 1)}
              disabled={submitting}
              data-testid="wizard-back"
            >
              ← 上一步
            </Button>
          )}
          <div className="ml-auto flex gap-3">
            {step === 2 && (
              <Button
                variant="ghost"
                size="md"
                onClick={() => {
                  setCopyFromId("");
                  setStep(3);
                }}
                data-testid="wizard-skip"
              >
                跳過
              </Button>
            )}
            {step < 3 ? (
              <Button size="md" onClick={next} data-testid="wizard-next">
                下一步 →
              </Button>
            ) : (
              <Button
                size="md"
                onClick={onCreate}
                disabled={submitting}
                data-testid="wizard-create"
              >
                {submitting ? "建立中…" : "建立使用者"}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* ── Post-create credential modal（一次性顯示） ── */}
      {created && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />
          <Card className="relative w-full max-w-md p-6" data-testid="created-modal">
            <h2 className="text-lg font-semibold">🎉 {created.email} 已建立</h2>
            {created.warning === "admin_role_granted" && (
              <p className="mt-2 text-xs text-amber-400">
                ⚠ 此帳號具 ADMIN 完整後台權限
              </p>
            )}
            <p className="mt-2 text-sm text-neutral-400">
              {created.inviteLink
                ? "邀請連結只顯示這一次（72 小時內有效），請複製後傳給使用者："
                : "臨時密碼只顯示這一次，請複製後安全轉交給使用者："}
            </p>
            <p className="mt-3 p-3 rounded-xl bg-black/40 border border-[var(--border-subtle)] font-mono text-xs text-neutral-200 break-all select-all">
              {credential}
            </p>
            <div className="mt-5 flex flex-wrap gap-3 justify-end">
              <Button
                variant="secondary"
                size="md"
                onClick={async () => {
                  await navigator.clipboard.writeText(credential).catch(() => undefined);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                data-testid="created-copy-btn"
              >
                {copied ? "✅ 已複製" : "複製到剪貼簿"}
              </Button>
              <Button
                size="md"
                onClick={() =>
                  router.push(`/admin/users/${encodeURIComponent(created.userId)}`)
                }
                data-testid="created-goto-detail"
              >
                前往使用者頁 →
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function MethodOption({
  selected,
  onSelect,
  title,
  description,
  testid,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description: string;
  testid: string;
}) {
  return (
    <label
      className={`flex items-start gap-3 p-4 rounded-xl border cursor-pointer transition-colors ${
        selected
          ? "border-[var(--accent-blue)]/60 bg-[var(--accent-blue)]/10"
          : "border-[var(--border-subtle)] hover:border-white/20"
      }`}
    >
      <input
        type="radio"
        name="invite-method"
        checked={selected}
        onChange={onSelect}
        className="mt-1 accent-[var(--accent-blue)]"
        data-testid={testid}
      />
      <span className="min-w-0">
        <span className={`block text-sm font-medium ${selected ? "text-white" : "text-neutral-200"}`}>
          {title}
        </span>
        <span className="block mt-0.5 text-xs text-neutral-500">{description}</span>
      </span>
    </label>
  );
}

function SummaryRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex gap-4 py-2.5 text-sm">
      <dt className="w-28 shrink-0 text-neutral-500">{label}</dt>
      <dd className={`min-w-0 break-words text-neutral-200 ${mono ? "font-mono" : ""}`}>
        {value}
      </dd>
    </div>
  );
}
