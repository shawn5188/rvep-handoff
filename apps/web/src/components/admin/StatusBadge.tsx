/**
 * c15 P3 — vehicle status badge shared by admin list / detail pages.
 * ONLINE green · SAFE_MODE amber · error-ish red · everything else grey.
 */

const STYLES: Record<string, { dot: string; text: string; label?: string }> = {
  ONLINE: { dot: "bg-emerald-400", text: "text-emerald-300" },
  SAFE_MODE: { dot: "bg-amber-400", text: "text-amber-300" },
  ERROR: { dot: "bg-[var(--accent-red)]", text: "text-[var(--accent-red)]" },
  DISCONNECTED: {
    dot: "bg-[var(--accent-red)]",
    text: "text-[var(--accent-red)]",
  },
  OFFLINE: { dot: "bg-neutral-500", text: "text-neutral-400" },
  UNKNOWN: { dot: "bg-neutral-600", text: "text-neutral-500" },
};

export function StatusBadge({
  status,
  archived = false,
  className = "",
}: {
  status: string;
  /** Archived overrides the live status visual. */
  archived?: boolean;
  className?: string;
}) {
  const style = archived
    ? { dot: "bg-neutral-700", text: "text-neutral-500", label: "ARCHIVED" }
    : STYLES[status] ?? STYLES.UNKNOWN;

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-mono uppercase tracking-wide ${style.text} ${className}`}
      data-testid="status-badge"
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`} />
      {style.label ?? status}
    </span>
  );
}
