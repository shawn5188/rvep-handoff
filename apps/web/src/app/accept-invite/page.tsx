"use client";

import { Suspense, useState, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { acceptInvite, ApiError } from "@/lib/api-client";
import { Brand } from "@/components/ui/Brand";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  checkPasswordPolicy,
  PasswordStrengthMeter,
  POLICY_REASON_MESSAGES,
} from "@/components/admin/PasswordStrengthMeter";

/**
 * c15 P4 — /accept-invite?token=xxx (PUBLIC, outside /admin).
 * The invited user opens the emailed link and sets their own password —
 * the admin never sees it. Success → /login?invited=1.
 */

const ERROR_MESSAGES: Record<string, string> = {
  invalid_invite_token: "邀請連結無效或已被使用，請聯絡管理員重發",
  invite_expired: "邀請連結已過期（72 小時），請聯絡管理員重發",
  weak_password: "密碼不符合規則",
  validation_error: "輸入格式不正確",
};

export default function AcceptInvitePage() {
  return (
    <Suspense>
      <AcceptInviteInner />
    </Suspense>
  );
}

function AcceptInviteInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const policy = checkPasswordPolicy(password);
    if (!policy.ok) {
      setError(POLICY_REASON_MESSAGES[policy.reason ?? ""] ?? "密碼不符合規則");
      return;
    }
    if (password !== confirm) {
      setError("兩次輸入的密碼不一致");
      return;
    }

    setLoading(true);
    try {
      await acceptInvite({ inviteToken: token, newPassword: password });
      router.replace("/login?invited=1");
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "network_error";
      setError(ERROR_MESSAGES[code] ?? `設定失敗：${code}`);
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-6">
      <div className="mb-10">
        <Brand size="lg" />
      </div>

      <Card className="w-full max-w-md p-8 sm:p-10">
        <header className="mb-8">
          <h1 className="text-3xl font-semibold tracking-tight">設定密碼</h1>
          <p className="mt-2 text-sm text-neutral-400">
            你收到了平台邀請 — 設定一組密碼即可啟用帳號
          </p>
        </header>

        {!token ? (
          <p className="text-sm text-[var(--accent-red)]" data-testid="invite-no-token">
            連結缺少邀請 token，請確認是否完整複製了邀請連結。
          </p>
        ) : (
          <form onSubmit={onSubmit} className="space-y-5">
            <label className="block">
              <span className="block text-xs uppercase tracking-[0.16em] text-neutral-500 mb-2">
                新密碼
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                data-testid="invite-password"
                className="w-full rounded-xl bg-black/40 border border-[var(--border-subtle)] px-4 h-12 text-base outline-none focus:border-white/30 transition-colors placeholder-neutral-600"
              />
              <PasswordStrengthMeter password={password} />
            </label>

            <label className="block">
              <span className="block text-xs uppercase tracking-[0.16em] text-neutral-500 mb-2">
                確認密碼
              </span>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
                data-testid="invite-confirm"
                className={`w-full rounded-xl bg-black/40 border px-4 h-12 text-base outline-none focus:border-white/30 transition-colors placeholder-neutral-600 ${
                  confirm.length > 0 && confirm !== password
                    ? "border-[var(--accent-red)]/70"
                    : "border-[var(--border-subtle)]"
                }`}
              />
              {confirm.length > 0 && confirm !== password && (
                <span className="block mt-1 text-xs text-[var(--accent-red)]">
                  兩次輸入的密碼不一致
                </span>
              )}
            </label>

            {error && (
              <p data-testid="invite-error" className="text-sm text-[var(--accent-red)]">
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={loading}
              size="xl"
              variant="primary"
              className="w-full"
              data-testid="invite-submit"
            >
              {loading ? "設定中…" : "設定密碼並啟用"}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
