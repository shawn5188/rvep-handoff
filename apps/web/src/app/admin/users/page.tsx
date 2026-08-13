"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  adminArchiveUser,
  adminListUsers,
  adminResendInvite,
  AdminUser,
  ApiError,
  RoleName,
} from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { RoleBadge } from "@/components/admin/RoleBadge";

/**
 * c15 P4 — /admin/users: user list.
 * Desktop (md+): dense table (engineer UX). Mobile: card list, 44px+ targets.
 * Filters: text / role / invite-pending / archived. Actions per row:
 * edit · reset password (deep-link to detail 密碼 tab) · resend invite ·
 * archive (confirm modal).
 */

const ERROR_MESSAGES: Record<string, string> = {
  cannot_archive_self: "不能封存自己的帳號",
  last_admin_protected: "至少要保留 1 位有效 Admin",
  user_already_archived: "此使用者已封存",
  invite_not_pending: "此使用者不在邀請待接受狀態",
};

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-TW", { hour12: false });
}

export default function AdminUsersPage() {
  const router = useRouter();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState<RoleName | "">("");
  const [pendingOnly, setPendingOnly] = useState(false);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<AdminUser | null>(null);
  const [resendResult, setResendResult] = useState<{ email: string; link: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await adminListUsers({
        includeArchived,
        ...(roleFilter ? { role: roleFilter } : {}),
      });
      setUsers(list);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : "network_error");
    }
  }, [includeArchived, roleFilter]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  const visible = useMemo(() => {
    if (!users) return null;
    const q = filter.trim().toLowerCase();
    return users.filter((u) => {
      if (pendingOnly && !u.invitePending) return false;
      if (!q) return true;
      return [u.email, u.displayName ?? "", u.role].join(" ").toLowerCase().includes(q);
    });
  }, [users, filter, pendingOnly]);

  async function onResendInvite(u: AdminUser) {
    setBusyId(u.id);
    try {
      const result = await adminResendInvite(u.id);
      await navigator.clipboard.writeText(result.inviteLink).catch(() => undefined);
      setResendResult({ email: u.email, link: result.inviteLink });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "resend_failed";
      setError(ERROR_MESSAGES[code] ?? code);
    } finally {
      setBusyId(null);
    }
  }

  async function onConfirmArchive() {
    if (!archiveTarget) return;
    const u = archiveTarget;
    setArchiveTarget(null);
    setBusyId(u.id);
    try {
      await adminArchiveUser(u.id);
      setNotice(`已封存 ${u.email}`);
      await load();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "archive_failed";
      setError(ERROR_MESSAGES[code] ?? code);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="max-w-6xl mx-auto">
      <section className="mb-6 flex flex-wrap items-start gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
          <p className="mt-2 text-sm text-neutral-400">使用者管理 · 每 15 秒自動刷新</p>
        </div>
        <div className="ml-auto">
          <Button
            size="md"
            onClick={() => router.push("/admin/users/new")}
            data-testid="add-user-btn"
          >
            + 加使用者
          </Button>
        </div>
      </section>

      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="search"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜尋 email / 名稱…"
          data-testid="user-filter"
          className="flex-1 min-w-[180px] max-w-sm rounded-xl bg-black/40 border border-[var(--border-subtle)] px-4 h-11 text-sm outline-none focus:border-white/30 transition-colors placeholder-neutral-600"
        />
        <select
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value as RoleName | "")}
          data-testid="role-filter"
          className="rounded-xl bg-black/40 border border-[var(--border-subtle)] px-3 h-11 text-sm outline-none appearance-none"
        >
          <option value="" className="bg-neutral-900">全部角色</option>
          <option value="ADMIN" className="bg-neutral-900">ADMIN</option>
          <option value="OPERATOR" className="bg-neutral-900">OPERATOR</option>
          <option value="VIEWER" className="bg-neutral-900">VIEWER</option>
        </select>
        <label className="inline-flex items-center gap-2 min-h-11 px-2 text-sm text-neutral-400 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={pendingOnly}
            onChange={(e) => setPendingOnly(e.target.checked)}
            className="accent-[var(--accent-blue)] w-4 h-4"
            data-testid="pending-toggle"
          />
          只看邀請中
        </label>
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
        <p
          className="text-sm text-[var(--accent-red)] mb-4 cursor-pointer"
          onClick={() => setError(null)}
          data-testid="users-error"
        >
          錯誤：{error}
        </p>
      )}
      {notice && (
        <p
          className="text-sm text-emerald-300 mb-4 cursor-pointer"
          data-testid="users-notice"
          onClick={() => setNotice(null)}
        >
          ✅ {notice}
        </p>
      )}

      {visible === null ? (
        <p className="text-sm text-neutral-500">載入中…</p>
      ) : visible.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-neutral-500" data-testid="users-empty">
            {filter || pendingOnly ? "沒有符合的使用者" : "尚無使用者 — 點右上「+ 加使用者」開始"}
          </p>
        </Card>
      ) : (
        <>
          {/* ── Desktop dense table ── */}
          <Card className="hidden md:block overflow-x-auto p-0">
            <table className="w-full text-sm" data-testid="users-table">
              <thead>
                <tr className="border-b border-[var(--border-subtle)] text-left">
                  <th className="px-4 py-3 font-medium text-neutral-500">Email</th>
                  <th className="px-4 py-3 font-medium text-neutral-500">名稱</th>
                  <th className="px-4 py-3 font-medium text-neutral-500">角色</th>
                  <th className="px-4 py-3 font-medium text-neutral-500">狀態</th>
                  <th className="px-4 py-3 font-medium text-neutral-500">上次登入</th>
                  <th className="px-4 py-3 font-medium text-neutral-500 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((u) => (
                  <tr
                    key={u.id}
                    className={`border-b border-[var(--border-subtle)] last:border-0 hover:bg-white/[0.03] transition-colors ${
                      u.archivedAt ? "opacity-50" : ""
                    }`}
                    data-testid={`user-row-${u.email}`}
                  >
                    <td className="px-4 py-2.5 font-mono">
                      <Link
                        href={`/admin/users/${encodeURIComponent(u.id)}`}
                        className="text-[var(--accent-blue)] hover:underline"
                      >
                        {u.email}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">{u.displayName ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <RoleBadge role={u.role} />
                    </td>
                    <td className="px-4 py-2.5">
                      <UserStateBadges user={u} />
                    </td>
                    <td className="px-4 py-2.5 text-neutral-400 font-mono text-xs">
                      {fmtTime(u.lastLoginAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      <RowActions
                        user={u}
                        busy={busyId === u.id}
                        onEdit={() => router.push(`/admin/users/${encodeURIComponent(u.id)}`)}
                        onResetPassword={() =>
                          router.push(`/admin/users/${encodeURIComponent(u.id)}?tab=password`)
                        }
                        onResendInvite={() => onResendInvite(u)}
                        onArchive={() => setArchiveTarget(u)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* ── Mobile card list ── */}
          <div className="md:hidden space-y-3" data-testid="users-cards">
            {visible.map((u) => (
              <Card
                key={u.id}
                className={`p-4 ${u.archivedAt ? "opacity-60" : ""}`}
                data-testid={`user-card-${u.email}`}
              >
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/admin/users/${encodeURIComponent(u.id)}`}
                      className="block font-mono text-[var(--accent-blue)] truncate"
                    >
                      {u.email}
                    </Link>
                    <p className="mt-0.5 text-sm text-neutral-200 truncate">
                      {u.displayName ?? "—"}
                    </p>
                    <p className="mt-1 text-xs text-neutral-500 font-mono">
                      上次登入 {fmtTime(u.lastLoginAt)}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <RoleBadge role={u.role} />
                    <UserStateBadges user={u} />
                  </div>
                </div>
                <div className="mt-3 pt-3 border-t border-[var(--border-subtle)]">
                  <RowActions
                    user={u}
                    busy={busyId === u.id}
                    onEdit={() => router.push(`/admin/users/${encodeURIComponent(u.id)}`)}
                    onResetPassword={() =>
                      router.push(`/admin/users/${encodeURIComponent(u.id)}?tab=password`)
                    }
                    onResendInvite={() => onResendInvite(u)}
                    onArchive={() => setArchiveTarget(u)}
                  />
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      {/* ── Archive confirm modal ── */}
      {archiveTarget && (
        <Modal onClose={() => setArchiveTarget(null)} testid="archive-user-modal">
          <h2 className="text-lg font-semibold">封存 {archiveTarget.email}？</h2>
          <p className="mt-2 text-sm text-neutral-400">
            封存後此帳號無法登入、現有 session 會失效，但歷史操作與 audit 紀錄保留，可隨時還原。
          </p>
          <div className="mt-5 flex gap-3 justify-end">
            <Button variant="ghost" size="md" onClick={() => setArchiveTarget(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              size="md"
              onClick={onConfirmArchive}
              data-testid="archive-user-confirm-btn"
            >
              封存
            </Button>
          </div>
        </Modal>
      )}

      {/* ── Resend invite result modal ── */}
      {resendResult && (
        <Modal onClose={() => setResendResult(null)} testid="resend-invite-modal">
          <h2 className="text-lg font-semibold">已重簽邀請連結</h2>
          <p className="mt-2 text-sm text-neutral-400">
            {resendResult.email} 的新邀請連結（72 小時內有效，已複製到剪貼簿）：
          </p>
          <p className="mt-3 p-3 rounded-xl bg-black/40 border border-[var(--border-subtle)] font-mono text-xs text-neutral-300 break-all">
            {resendResult.link}
          </p>
          <div className="mt-5 flex gap-3 justify-end">
            <Button
              variant="secondary"
              size="md"
              onClick={async () => {
                await navigator.clipboard.writeText(resendResult.link).catch(() => undefined);
              }}
            >
              再複製一次
            </Button>
            <Button size="md" onClick={() => setResendResult(null)}>
              完成
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function UserStateBadges({ user }: { user: AdminUser }) {
  const locked = user.lockedUntil !== null && new Date(user.lockedUntil) > new Date();
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {user.archivedAt !== null && (
        <span className="px-1.5 py-0.5 rounded border border-[var(--border-strong)] text-[11px] font-mono text-neutral-500">
          ARCHIVED
        </span>
      )}
      {user.invitePending && (
        <span
          className="px-1.5 py-0.5 rounded border border-amber-400/50 text-[11px] font-mono text-amber-300"
          data-testid="invite-pending-badge"
        >
          邀請中
        </span>
      )}
      {locked && (
        <span className="px-1.5 py-0.5 rounded border border-[var(--accent-red)]/50 text-[11px] font-mono text-[var(--accent-red)]">
          鎖定
        </span>
      )}
      {!user.archivedAt && !user.invitePending && !locked && (
        <span className="px-1.5 py-0.5 rounded border border-emerald-400/40 text-[11px] font-mono text-emerald-300">
          有效
        </span>
      )}
    </span>
  );
}

function RowActions({
  user,
  busy,
  onEdit,
  onResetPassword,
  onResendInvite,
  onArchive,
}: {
  user: AdminUser;
  busy: boolean;
  onEdit: () => void;
  onResetPassword: () => void;
  onResendInvite: () => void;
  onArchive: () => void;
}) {
  const archived = user.archivedAt !== null;
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
        onClick={onResetPassword}
        disabled={busy || archived}
        className={action}
        data-testid="row-reset-password"
      >
        重設密碼
      </button>
      {user.invitePending && (
        <button
          onClick={onResendInvite}
          disabled={busy || archived}
          className={action}
          data-testid="row-resend-invite"
        >
          重發邀請
        </button>
      )}
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

function Modal({
  children,
  onClose,
  testid,
}: {
  children: React.ReactNode;
  onClose: () => void;
  testid: string;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <button
        aria-label="關閉"
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <Card className="relative w-full max-w-sm p-6" data-testid={testid}>
        {children}
      </Card>
    </div>
  );
}
