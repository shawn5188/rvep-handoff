"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getMe, logout, ApiError, MeResponse } from "@/lib/api-client";
import { AdminShell } from "@/components/admin/AdminShell";

/**
 * c15 P2 — /admin/* group layout.
 *
 * Client-side RBAC gate (defense in depth; the real enforcement is the
 * backend withAdmin wrapper): unauthenticated → /login, non-ADMIN → /vehicles.
 * Children only render after the role check passes, so non-admins never see
 * a flash of admin chrome.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<MeResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((m) => {
        if (cancelled) return;
        if (m.role !== "ADMIN") {
          router.replace("/vehicles");
          return;
        }
        setMe(m);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
        } else {
          router.replace("/vehicles");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function onLogout() {
    await logout();
    router.replace("/login");
  }

  if (!me) {
    return (
      <div className="min-h-dvh flex items-center justify-center">
        <p className="text-sm text-neutral-500" data-testid="admin-loading">
          驗證權限中…
        </p>
      </div>
    );
  }

  return (
    <AdminShell me={me} onLogout={onLogout}>
      {children}
    </AdminShell>
  );
}
