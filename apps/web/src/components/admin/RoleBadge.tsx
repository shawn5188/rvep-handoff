import type { RoleName } from "@/lib/api-client";

/**
 * c15 P4 — role badge shared by admin user list / detail / permission views.
 * ADMIN red (full control — treat with care) · OPERATOR blue · VIEWER grey.
 */

const STYLES: Record<RoleName, string> = {
  ADMIN:
    "border-[var(--accent-red)]/50 text-[var(--accent-red)] bg-[var(--accent-red)]/10",
  OPERATOR:
    "border-[var(--accent-blue)]/50 text-[var(--accent-blue)] bg-[var(--accent-blue)]/10",
  VIEWER: "border-[var(--border-strong)] text-neutral-400 bg-white/5",
};

export function RoleBadge({
  role,
  className = "",
}: {
  role: RoleName;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] font-mono uppercase tracking-wide ${STYLES[role]} ${className}`}
      data-testid="role-badge"
    >
      {role}
    </span>
  );
}
