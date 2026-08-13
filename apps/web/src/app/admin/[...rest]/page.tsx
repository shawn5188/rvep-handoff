"use client";

import { usePathname, useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

/**
 * c15 P2 — catch-all placeholder for admin routes that ship in later phases
 * (P3 vehicles / P4 users / P5 permissions). Keeps sidebar links + dashboard
 * quick actions from 404-ing while those pages are under construction.
 *
 * P3+ note: adding a real page (e.g. app/admin/vehicles/page.tsx) automatically
 * takes precedence over this catch-all — no need to modify this file.
 */
export default function AdminPlaceholderPage() {
  const pathname = usePathname();
  const router = useRouter();

  return (
    <div className="max-w-6xl mx-auto">
      <Card className="p-8 sm:p-10 text-center" data-testid="admin-placeholder">
        <p className="text-xs uppercase tracking-[0.18em] text-neutral-600 font-mono mb-3">
          {pathname}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">功能建置中</h1>
        <p className="mt-2 text-sm text-neutral-400">
          此後台功能將於後續版本開放
        </p>
        <div className="mt-6">
          <Button variant="secondary" size="md" onClick={() => router.push("/admin")}>
            ← 回 Dashboard
          </Button>
        </div>
      </Card>
    </div>
  );
}
