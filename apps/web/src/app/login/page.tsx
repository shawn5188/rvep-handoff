"use client";

import { Suspense, useState, FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { login, ApiError } from "@/lib/api-client";
import { Brand } from "@/components/ui/Brand";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  // c15 P4 — arriving from /accept-invite after setting the password.
  const invited = useSearchParams().get("invited") === "1";
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("Admin1234!");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email, password);
      router.replace("/vehicles");
    } catch (err) {
      const msg = err instanceof ApiError ? err.code : "network_error";
      setError(msg);
    } finally {
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
          <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
          <p className="mt-2 text-sm text-neutral-400">
            遠端車輛邊緣控制 · 操作員 / 觀察員介面
          </p>
        </header>

        {invited && (
          <p
            className="mb-6 text-sm text-emerald-300"
            data-testid="login-invited-notice"
          >
            ✅ 密碼已設定，請登入
          </p>
        )}

        <form onSubmit={onSubmit} className="space-y-5">
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            testid="login-email"
          />
          <Field
            label="密碼"
            type="password"
            value={password}
            onChange={setPassword}
            testid="login-password"
          />

          {error && (
            <p
              data-testid="login-error"
              className="text-sm text-[var(--accent-red)]"
            >
              {error === "invalid_credentials"
                ? "Email 或密碼錯誤"
                : error === "account_locked"
                  ? "帳號鎖定中，請稍後再試"
                  : `登入失敗：${error}`}
            </p>
          )}

          <Button
            type="submit"
            disabled={loading}
            size="xl"
            variant="primary"
            className="w-full"
            data-testid="login-submit"
          >
            {loading ? "登入中…" : "Continue"}
          </Button>
        </form>

        <p className="mt-8 text-[11px] uppercase tracking-[0.18em] text-neutral-600">
          v0.1 · dev build
        </p>
      </Card>
    </main>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  testid,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  testid: string;
}) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-[0.16em] text-neutral-500 mb-2">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        autoComplete={type === "password" ? "current-password" : "email"}
        data-testid={testid}
        className="w-full rounded-xl bg-black/40 border border-[var(--border-subtle)] px-4 h-12 text-base outline-none focus:border-white/30 transition-colors placeholder-neutral-600"
      />
    </label>
  );
}
