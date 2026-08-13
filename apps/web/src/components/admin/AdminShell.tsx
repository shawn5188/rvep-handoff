"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/ui/Brand";
import type { MeResponse } from "@/lib/api-client";

/**
 * c15 P2 — shared admin shell: left sidebar (drawer on mobile), top breadcrumb
 * and user menu. Every /admin/* page (P3-P7) renders inside this shell via
 * app/admin/layout.tsx — pages only provide their own content, no headers.
 */

interface NavItem {
  href: string;
  label: string;
  icon: (props: { className?: string }) => React.ReactNode;
  /** exact = active only on full match (dashboard), otherwise prefix match */
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/admin", label: "Dashboard", icon: IconGrid, exact: true },
  { href: "/admin/vehicles", label: "Vehicles", icon: IconTruck },
  { href: "/admin/users", label: "Users", icon: IconUsers },
  { href: "/admin/permissions", label: "Permissions", icon: IconShield },
  { href: "/admin/audit", label: "Audit", icon: IconList },
  { href: "/admin/datasets", label: "Datasets", icon: IconDatabase },
];

/** Segment → breadcrumb label. Unknown segments (ids) render verbatim. */
const CRUMB_LABELS: Record<string, string> = {
  admin: "Admin",
  vehicles: "Vehicles",
  users: "Users",
  permissions: "Permissions",
  audit: "Audit",
  datasets: "Datasets",
  new: "New",
};

export function AdminShell({
  me,
  onLogout,
  children,
}: {
  me: MeResponse;
  onLogout: () => void;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the mobile drawer whenever navigation happens.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-dvh md:flex safe-pad-x">
      {/* ── Desktop sidebar ── */}
      <aside className="hidden md:flex md:flex-col w-60 shrink-0 md:sticky md:top-0 md:h-dvh border-r border-[var(--border-subtle)] bg-black/20">
        <SidebarContent pathname={pathname} />
      </aside>

      {/* ── Mobile drawer ── */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true">
          <button
            aria-label="關閉選單"
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setDrawerOpen(false)}
            data-testid="admin-drawer-backdrop"
          />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] flex flex-col bg-[var(--bg-1)] border-r border-[var(--border-strong)] safe-pad-y">
            <SidebarContent pathname={pathname} onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      )}

      {/* ── Main column ── */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="sticky top-0 z-40 flex items-center gap-3 h-14 px-4 sm:px-6 border-b border-[var(--border-subtle)] bg-[var(--bg-0)]/80 backdrop-blur safe-pad-y">
          <button
            className="md:hidden inline-flex items-center justify-center w-11 h-11 -ml-2 rounded-lg text-neutral-300 hover:text-white"
            onClick={() => setDrawerOpen(true)}
            aria-label="開啟選單"
            data-testid="admin-menu-btn"
          >
            <IconMenu className="w-5 h-5" />
          </button>

          <Breadcrumb pathname={pathname} />

          <div className="ml-auto">
            <UserMenu me={me} onLogout={onLogout} />
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8" data-testid="admin-content">
          {children}
        </main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

function SidebarContent({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <>
      <div className="px-5 pt-6 pb-4">
        <Brand size="md" />
        <p className="mt-2 text-[11px] uppercase tracking-[0.18em] text-neutral-600">
          Admin Console
        </p>
      </div>

      <nav className="flex-1 px-3 space-y-1 overflow-y-auto" data-testid="admin-sidebar">
        {NAV_ITEMS.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              data-testid={`admin-nav-${item.label.toLowerCase()}`}
              className={`flex items-center gap-3 h-11 px-3 rounded-xl text-sm transition-colors ${
                active
                  ? "bg-white/10 text-white font-medium"
                  : "text-neutral-400 hover:text-white hover:bg-white/5"
              }`}
            >
              <item.icon className="w-[18px] h-[18px] shrink-0" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 py-4 border-t border-[var(--border-subtle)]">
        <Link
          href="/vehicles"
          onClick={onNavigate}
          className="flex items-center gap-3 h-11 px-3 rounded-xl text-sm text-neutral-500 hover:text-white hover:bg-white/5 transition-colors"
          data-testid="admin-back-to-fleet"
        >
          <IconArrowLeft className="w-[18px] h-[18px] shrink-0" />
          回 Fleet
        </Link>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Breadcrumb — derived from the URL: /admin/vehicles/vehicle-001
//   → Admin > Vehicles > vehicle-001
// ---------------------------------------------------------------------------

function Breadcrumb({ pathname }: { pathname: string }) {
  const segments = pathname.split("/").filter(Boolean); // ["admin", ...]
  const crumbs = segments.map((seg, i) => ({
    label: CRUMB_LABELS[seg] ?? decodeURIComponent(seg),
    href: `/${segments.slice(0, i + 1).join("/")}`,
    isLast: i === segments.length - 1,
  }));

  return (
    <nav aria-label="breadcrumb" className="min-w-0" data-testid="admin-breadcrumb">
      <ol className="flex items-center gap-1.5 text-sm whitespace-nowrap overflow-x-auto">
        {crumbs.map((c) => (
          <li key={c.href} className="flex items-center gap-1.5 min-w-0">
            {c.isLast ? (
              <span className="text-neutral-100 font-medium truncate">{c.label}</span>
            ) : (
              <>
                <Link
                  href={c.href}
                  className="text-neutral-500 hover:text-white transition-colors"
                >
                  {c.label}
                </Link>
                <span className="text-neutral-700">/</span>
              </>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// User menu — avatar initial → dropdown with email + role + logout
// ---------------------------------------------------------------------------

function UserMenu({ me, onLogout }: { me: MeResponse; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const email = me.email ?? me.userId;
  const initial = (me.displayName ?? email).charAt(0).toUpperCase();

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="admin-user-menu-btn"
        className="flex items-center gap-2 h-11 pl-1.5 pr-3 rounded-full surface surface-hover"
      >
        <span className="flex items-center justify-center w-8 h-8 rounded-full bg-[var(--accent-blue)]/20 text-[var(--accent-blue)] text-sm font-semibold">
          {initial}
        </span>
        <span className="hidden sm:block max-w-[180px] truncate text-sm text-neutral-300">
          {email}
        </span>
      </button>

      {open && (
        <>
          <button
            aria-label="關閉使用者選單"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            data-testid="admin-user-menu"
            className="absolute right-0 top-full mt-2 z-50 w-64 surface rounded-[var(--radius-md)] p-4 shadow-2xl"
          >
            <p className="text-sm text-neutral-100 truncate">{email}</p>
            <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-[var(--accent-blue)]">
              {me.role}
            </p>
            <button
              onClick={onLogout}
              data-testid="admin-logout-btn"
              className="mt-4 w-full h-11 rounded-xl text-sm text-neutral-300 border border-[var(--border-subtle)] hover:border-[var(--accent-red)]/60 hover:text-[var(--accent-red)] transition-colors"
            >
              登出
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline icons (stroke = currentColor) — no icon package per project rules
// ---------------------------------------------------------------------------

function svgProps(className?: string) {
  return {
    className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

function IconGrid({ className }: { className?: string }) {
  return (
    <svg {...svgProps(className)}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function IconTruck({ className }: { className?: string }) {
  return (
    <svg {...svgProps(className)}>
      <path d="M3 7h11v9H3z" />
      <path d="M14 10h4l3 3v3h-7" />
      <circle cx="7" cy="18" r="1.8" />
      <circle cx="17" cy="18" r="1.8" />
    </svg>
  );
}

function IconUsers({ className }: { className?: string }) {
  return (
    <svg {...svgProps(className)}>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5" />
      <path d="M16 5.5a3 3 0 0 1 0 5.5" />
      <path d="M17.5 14.8c1.7.6 2.7 1.9 3 4.2" />
    </svg>
  );
}

function IconShield({ className }: { className?: string }) {
  return (
    <svg {...svgProps(className)}>
      <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

function IconList({ className }: { className?: string }) {
  return (
    <svg {...svgProps(className)}>
      <path d="M9 6h12M9 12h12M9 18h12" />
      <circle cx="4" cy="6" r="1" fill="currentColor" />
      <circle cx="4" cy="12" r="1" fill="currentColor" />
      <circle cx="4" cy="18" r="1" fill="currentColor" />
    </svg>
  );
}

function IconDatabase({ className }: { className?: string }) {
  return (
    <svg {...svgProps(className)}>
      <ellipse cx="12" cy="5.5" rx="8" ry="2.8" />
      <path d="M4 5.5v13c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-13" />
      <path d="M4 12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8" />
    </svg>
  );
}

function IconMenu({ className }: { className?: string }) {
  return (
    <svg {...svgProps(className)}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

function IconArrowLeft({ className }: { className?: string }) {
  return (
    <svg {...svgProps(className)}>
      <path d="M19 12H5M11 6l-6 6 6 6" />
    </svg>
  );
}
