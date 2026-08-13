"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  adminArchiveUser,
  adminGetUser,
  adminResendInvite,
  adminResetUserPassword,
  adminUpdateUser,
  AdminUserDetail,
  ApiError,
  UpdateUserInput,
} from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { RoleBadge } from "@/components/admin/RoleBadge";
import {
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
 * c15 P4 — /admin/users/[id]: user detail.
 * Header info card + 4 tabs（基本 inline edit / 密碼 / 權限 readonly / 活動）+
 * archive / restore. ?tab=password deep-links from the list's 重設密碼 action.
 */

const TABS = ["基本", "密碼", "權限", "活動"] as const;
type Tab = (typeof TABS)[number];

const ERROR_MESSAGES: Record<string, string> = {
  email_taken: "這個 Email 已被使用",
  last_admin_protected: "至少要保留 1 位有效 Admin",
  cannot_archive_self: "不能封存自己的帳號",
  user_already_archived: "此使用者已封存",
  weak_password: "密碼不符合規則",
  invite_not_pending: "此使用者不在邀請待接受狀態",
  user_archived: "此使用者已封存，請先還原",
};

function errMsg(err: unknown, fallback: string): string {
  const code = err instanceof ApiError ? err.code : fallback;
  return ERROR_MESSAGES[code] ?? code;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", { hour12: false });
}

export default function UserDetailPage() {
  return (
    <Suspense>
      <UserDetailInner />
    </Suspense>
  );
}

function UserDetailInner() {
  const params = useParams<{ id: string }>();
  const userId = decodeURIComponent(params.id);
  const router = useRouter();
  const searchParams = useSearchParams();

  const [detail, setDetail] = useState<AdminUserDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(
    searchParams.get("tab") === "password" ? "密碼" : "基本",
  );
  const [busy, setBusy] = useState(false);
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await adminGetUser(userId);
      setDetail(d);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "network_error");
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onArchive() {
    setShowArchiveConfirm(false);
    setBusy(true);
    try {
      await adminArchiveUser(userId);
      setNotice("已封存");
      await load();
    } catch (err) {
      setError(errMsg(err, "archive_failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onRestore() {
    setBusy(true);
    try {
      await adminUpdateUser(userId, { archivedAt: null });
      setNotice("已還原");
      await load();
    } catch (err) {
      setError(errMsg(err, "restore_failed"));
    } finally {
      setBusy(false);
    }
  }

  if (error && !detail) {
    return (
      <div className="max-w-4xl mx-auto">
        <p className="text-sm text-[var(--accent-red)]" data-testid="detail-error">
          {error === "user_not_found" ? "找不到這個使用者" : `錯誤：${error}`}
        </p>
        <Button
          variant="secondary"
          size="md"
          className="mt-4"
          onClick={() => router.push("/admin/users")}
        >
          ← 回列表
        </Button>
      </div>
    );
  }

  if (!detail) {
    return <p className="max-w-4xl mx-auto text-sm text-neutral-500">載入中…</p>;
  }

  const archived = detail.archivedAt !== null;

  return (
    <div className="max-w-4xl mx-auto">
      {/* ── Header info card ── */}
      <Card className="p-5 sm:p-6 mb-6" data-testid="detail-header">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight font-mono truncate">
                {detail.email}
              </h1>
              <RoleBadge role={detail.role} />
              {archived && (
                <span className="px-1.5 py-0.5 rounded border border-[var(--border-strong)] text-[11px] font-mono text-neutral-500">
                  ARCHIVED
                </span>
              )}
              {detail.invitePending && (
                <span className="px-1.5 py-0.5 rounded border border-amber-400/50 text-[11px] font-mono text-amber-300">
                  邀請中
                </span>
              )}
            </div>
            <p className="mt-1 text-neutral-300">{detail.displayName ?? "—"}</p>
            <p className="mt-2 text-xs text-neutral-500">
              建立於 {fmtTime(detail.createdAt)} · 上次登入 {fmtTime(detail.lastLoginAt)}
            </p>
          </div>
          {archived ? (
            <Button
              variant="secondary"
              size="md"
              onClick={onRestore}
              disabled={busy}
              data-testid="detail-restore-btn"
            >
              還原
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="md"
              onClick={() => setShowArchiveConfirm(true)}
              disabled={busy}
              className="hover:text-[var(--accent-red)]"
              data-testid="detail-archive-btn"
            >
              封存
            </Button>
          )}
        </div>
      </Card>

      {error && (
        <p
          className="text-sm text-[var(--accent-red)] mb-4 cursor-pointer"
          onClick={() => setError(null)}
        >
          錯誤：{error}
        </p>
      )}
      {notice && (
        <p
          className="text-sm text-emerald-300 mb-4 cursor-pointer"
          onClick={() => setNotice(null)}
          data-testid="detail-notice"
        >
          ✅ {notice}
        </p>
      )}

      {/* ── Tabs ── */}
      <div
        className="flex gap-1 mb-5 overflow-x-auto border-b border-[var(--border-subtle)]"
        role="tablist"
        data-testid="detail-tabs"
      >
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`min-h-11 px-4 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
              tab === t
                ? "border-[var(--accent-blue)] text-white font-medium"
                : "border-transparent text-neutral-500 hover:text-neutral-200"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "基本" && (
        <BasicTab
          detail={detail}
          disabled={archived || busy}
          onSaved={async (msg) => {
            setNotice(msg);
            await load();
          }}
          onError={(code) => setError(ERROR_MESSAGES[code] ?? code)}
        />
      )}
      {tab === "密碼" && (
        <PasswordTab detail={detail} archived={archived} onChanged={load} />
      )}
      {tab === "權限" && <PermissionsTab detail={detail} />}
      {tab === "活動" && <ActivityTab detail={detail} />}

      {/* ── Archive confirm ── */}
      {showArchiveConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <button
            aria-label="取消"
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setShowArchiveConfirm(false)}
          />
          <Card className="relative w-full max-w-sm p-6" data-testid="archive-modal">
            <h2 className="text-lg font-semibold">封存 {detail.email}？</h2>
            <p className="mt-2 text-sm text-neutral-400">
              封存後此帳號無法登入、現有 session 會失效，歷史紀錄保留，可隨時還原。
            </p>
            <div className="mt-5 flex gap-3 justify-end">
              <Button variant="ghost" size="md" onClick={() => setShowArchiveConfirm(false)}>
                取消
              </Button>
              <Button
                variant="danger"
                size="md"
                onClick={onArchive}
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

// ---------------------------------------------------------------------------
// 基本 — inline editable email / displayName / role
// ---------------------------------------------------------------------------

function detailToForm(d: AdminUserDetail): UserFormValues {
  return {
    email: d.email,
    displayName: d.displayName ?? "",
    role: d.role,
  };
}

function buildPatch(original: AdminUserDetail, values: UserFormValues): UpdateUserInput {
  const patch: UpdateUserInput = {};
  if (values.email.trim() !== original.email) patch.email = values.email.trim();
  if (values.displayName.trim() !== (original.displayName ?? ""))
    patch.displayName = values.displayName.trim();
  if (values.role !== original.role) patch.role = values.role;
  return patch;
}

function BasicTab({
  detail,
  disabled,
  onSaved,
  onError,
}: {
  detail: AdminUserDetail;
  disabled: boolean;
  onSaved: (msg: string) => Promise<void>;
  onError: (code: string) => void;
}) {
  const [values, setValues] = useState<UserFormValues>(() => detailToForm(detail));
  const [errors, setErrors] = useState<UserFormErrors>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValues(detailToForm(detail));
    setErrors({});
  }, [detail]);

  const dirty = useMemo(
    () => Object.keys(buildPatch(detail, values)).length > 0,
    [detail, values],
  );

  function onChange(patch: Partial<UserFormValues>) {
    setValues((v) => ({ ...v, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const key of Object.keys(patch)) delete next[key as keyof UserFormValues];
      return next;
    });
  }

  async function onSave() {
    const errs = validateUserBasic(values);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    try {
      await adminUpdateUser(detail.id, buildPatch(detail, values));
      await onSaved("已儲存變更");
    } catch (err) {
      onError(err instanceof ApiError ? err.code : "save_failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-5 sm:p-6" data-testid="tab-basic">
      <UserFormFields values={values} errors={errors} onChange={onChange} />
      {dirty && !disabled && (
        <div className="mt-6 flex gap-3 justify-end">
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              setValues(detailToForm(detail));
              setErrors({});
            }}
            disabled={saving}
            data-testid="basic-cancel"
          >
            取消
          </Button>
          <Button size="md" onClick={onSave} disabled={saving} data-testid="basic-save">
            {saving ? "儲存中…" : "儲存"}
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 密碼 — login stats + reset via invite link or manual temp password
// ---------------------------------------------------------------------------

function PasswordTab({
  detail,
  archived,
  onChanged,
}: {
  detail: AdminUserDetail;
  archived: boolean;
  onChanged: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualPassword, setManualPassword] = useState("");
  const [result, setResult] = useState<{ label: string; value: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const locked =
    detail.lockedUntil !== null && new Date(detail.lockedUntil) > new Date();

  async function onResetInvite() {
    setBusy(true);
    setError(null);
    try {
      const r = await adminResetUserPassword(detail.id, { method: "invite_link" });
      setResult({ label: "新邀請連結（72h 有效，只顯示這一次）", value: r.inviteLink! });
      await onChanged();
    } catch (err) {
      setError(errMsg(err, "reset_failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onResetManual() {
    const policy = checkPasswordPolicy(manualPassword);
    if (!policy.ok) {
      setError(POLICY_REASON_MESSAGES[policy.reason ?? ""] ?? "密碼不符合規則");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await adminResetUserPassword(detail.id, {
        method: "manual",
        manualPassword,
      });
      setResult({ label: "臨時密碼（只顯示這一次）", value: r.temporaryPassword! });
      setManualPassword("");
      await onChanged();
    } catch (err) {
      setError(errMsg(err, "reset_failed"));
    } finally {
      setBusy(false);
    }
  }

  async function onResend() {
    setBusy(true);
    setError(null);
    try {
      const r = await adminResendInvite(detail.id);
      setResult({ label: "新邀請連結（72h 有效，只顯示這一次）", value: r.inviteLink });
    } catch (err) {
      setError(errMsg(err, "resend_failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="tab-password">
      {/* ── Login stats ── */}
      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold mb-3">登入狀態</h2>
        <dl className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-xs text-neutral-500">上次登入</dt>
            <dd className="mt-1 font-mono text-neutral-200">{fmtTime(detail.lastLoginAt)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">連續登入失敗</dt>
            <dd
              className={`mt-1 font-mono ${
                detail.failedLoginCount > 0 ? "text-amber-300" : "text-neutral-200"
              }`}
            >
              {detail.failedLoginCount} 次
            </dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">鎖定至</dt>
            <dd
              className={`mt-1 font-mono ${
                locked ? "text-[var(--accent-red)]" : "text-neutral-200"
              }`}
            >
              {locked ? fmtTime(detail.lockedUntil) : "未鎖定"}
            </dd>
          </div>
        </dl>
        {locked && (
          <p className="mt-3 text-xs text-neutral-500">
            重設密碼（任一方式）會同時解除鎖定。
          </p>
        )}
      </Card>

      {error && (
        <p className="text-sm text-[var(--accent-red)] cursor-pointer" onClick={() => setError(null)}>
          錯誤：{error}
        </p>
      )}

      {/* ── One-shot credential result ── */}
      {result && (
        <Card className="p-5 sm:p-6 border-emerald-400/30" data-testid="reset-result">
          <h2 className="text-base font-semibold text-emerald-300">✅ {result.label}</h2>
          <p className="mt-3 p-3 rounded-xl bg-black/40 border border-[var(--border-subtle)] font-mono text-xs text-neutral-200 break-all select-all">
            {result.value}
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={async () => {
              await navigator.clipboard.writeText(result.value).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
            data-testid="reset-copy-btn"
          >
            {copied ? "✅ 已複製" : "複製到剪貼簿"}
          </Button>
        </Card>
      )}

      {/* ── Invite link reset ── */}
      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold">重簽邀請連結</h2>
        <p className="mt-1 text-sm text-neutral-400">
          產生新的 72 小時邀請連結，由使用者自行設定新密碼；現有 session 立即失效。
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Button
            variant="secondary"
            size="md"
            onClick={onResetInvite}
            disabled={busy || archived}
            data-testid="reset-invite-btn"
          >
            重簽邀請連結
          </Button>
          {detail.invitePending && (
            <Button
              variant="ghost"
              size="md"
              onClick={onResend}
              disabled={busy || archived}
              data-testid="resend-invite-btn"
            >
              重發邀請（展期 72h）
            </Button>
          )}
        </div>
      </Card>

      {/* ── Manual temp password ── */}
      <Card className="p-5 sm:p-6">
        <h2 className="text-base font-semibold">手動設定臨時密碼</h2>
        <p className="mt-1 text-sm text-neutral-400">
          直接設定一組臨時密碼並轉交使用者；現有 session 立即失效。
        </p>
        <div className="mt-4">
          <input
            type="text"
            value={manualPassword}
            onChange={(e) => setManualPassword(e.target.value)}
            placeholder="至少 12 字元，含英文字母 + 數字"
            autoComplete="off"
            disabled={archived}
            data-testid="manual-password-input"
            className="w-full max-w-md rounded-xl bg-black/40 border border-[var(--border-subtle)] px-4 h-12 text-base font-mono outline-none focus:border-white/30 transition-colors placeholder-neutral-600 disabled:opacity-50"
          />
          <div className="max-w-md">
            <PasswordStrengthMeter password={manualPassword} />
          </div>
          <Button
            size="md"
            className="mt-3"
            onClick={onResetManual}
            disabled={busy || archived || manualPassword.length === 0}
            data-testid="reset-manual-btn"
          >
            設定臨時密碼
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 權限 — readonly per-vehicle role snapshot（P5 permission matrix 頁修改）
// ---------------------------------------------------------------------------

function PermissionsTab({ detail }: { detail: AdminUserDetail }) {
  return (
    <Card className="p-5 sm:p-6" data-testid="tab-permissions">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">
          載具權限（{detail.permissions.length}）
        </h2>
        <Link
          href={`/admin/permissions/${encodeURIComponent(detail.id)}`}
          className="ml-auto text-sm text-[var(--accent-blue)] hover:underline"
          data-testid="goto-permissions"
        >
          到 Permissions 頁修改 →
        </Link>
      </div>
      <p className="mt-1 text-sm text-neutral-400">
        此頁為唯讀快照，細部編輯（含 priority override）在 permission matrix。
      </p>

      {detail.permissions.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">
          尚未指派任何載具權限
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-[var(--border-subtle)]">
          {detail.permissions.map((p) => (
            <li
              key={p.vehicleId}
              className="py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
              data-testid={`perm-${p.vehicleId}`}
            >
              <span className="font-mono text-neutral-200">{p.vehicleId}</span>
              <span className="text-neutral-500 truncate">{p.vehicleDisplayName}</span>
              <span className="ml-auto flex items-center gap-2">
                {p.priorityOverride !== null && (
                  <span className="px-1.5 py-0.5 rounded border border-amber-400/50 text-[11px] font-mono text-amber-300">
                    P{p.priorityOverride}
                  </span>
                )}
                <RoleBadge role={p.role} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 活動 — recent audit trail where this user is the actor
// ---------------------------------------------------------------------------

function ActivityTab({ detail }: { detail: AdminUserDetail }) {
  return (
    <Card className="p-5 sm:p-6" data-testid="tab-activity">
      <h2 className="text-base font-semibold mb-3">
        最近活動（{detail.recentAuditEvents.length}）
      </h2>
      {detail.recentAuditEvents.length === 0 ? (
        <p className="text-sm text-neutral-500">尚無活動紀錄</p>
      ) : (
        <ul className="divide-y divide-[var(--border-subtle)]">
          {detail.recentAuditEvents.map((e) => (
            <li key={e.id} className="py-2.5 text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="px-1.5 py-0.5 rounded border border-[var(--border-strong)] text-[11px] font-mono text-neutral-300">
                {e.eventName}
              </span>
              {e.targetType && (
                <span className="text-xs text-neutral-500 font-mono">
                  {e.targetType}
                  {e.targetId ? ` · ${e.targetId.slice(0, 8)}…` : ""}
                </span>
              )}
              <span className="text-xs text-neutral-500 font-mono ml-auto">
                {fmtTime(e.ts)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
