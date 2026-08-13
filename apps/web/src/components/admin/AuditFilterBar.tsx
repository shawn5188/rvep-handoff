"use client";

import { useEffect, useRef, useState } from "react";
import { AdminUser } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";

/**
 * c15 P6 — audit viewer filter bar.
 * Desktop: inline toolbar. Mobile: collapsed behind a 篩選 toggle (drawer).
 * Time-range shortcuts + custom range, grouped event multi-select,
 * actor email autocomplete (datalist), target search, live toggle, CSV export.
 */

export type AuditRangePreset = "1h" | "24h" | "7d" | "30d" | "custom";

export interface AuditFilterState {
  range: AuditRangePreset;
  /** datetime-local values, only used when range === "custom". */
  customSince: string;
  customUntil: string;
  eventNames: string[];
  actorEmail: string;
  target: string;
  live: boolean;
}

export const DEFAULT_AUDIT_FILTERS: AuditFilterState = {
  range: "24h",
  customSince: "",
  customUntil: "",
  eventNames: [],
  actorEmail: "",
  target: "",
  live: false,
};

const RANGE_PRESETS: Array<{ value: AuditRangePreset; label: string }> = [
  { value: "1h", label: "1 小時" },
  { value: "24h", label: "24 小時" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "custom", label: "自訂" },
];

/** Known audit event names, grouped by domain (P2-P5 emitters + P6 export). */
export const EVENT_GROUPS: Array<{ label: string; events: string[] }> = [
  {
    label: "Vehicle",
    events: [
      "vehicle_created",
      "vehicle_updated",
      "vehicle_archived",
      "vehicle_token_minted",
      "vehicle_deploy_package_generated",
    ],
  },
  {
    label: "User",
    events: [
      "user_created",
      "user_updated",
      "user_role_changed",
      "user_email_changed",
      "user_archived",
      "user_password_reset",
      "user_invite_resent",
      "user_invite_accepted",
      "login_success",
    ],
  },
  { label: "Permission", events: ["user_permissions_updated"] },
  {
    label: "Session",
    events: ["admin_api_access", "admin_api_denied", "audit_log_exported"],
  },
];

const inputCls =
  "rounded-xl bg-black/40 border border-[var(--border-subtle)] px-3 h-11 text-sm " +
  "outline-none focus:border-white/30 transition-colors placeholder-neutral-600";

export function AuditFilterBar({
  value,
  onChange,
  users,
  onExport,
  exporting,
}: {
  value: AuditFilterState;
  onChange: (next: AuditFilterState) => void;
  /** For the actor email autocomplete (may still be loading → null). */
  users: AdminUser[] | null;
  onExport: () => void;
  exporting: boolean;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const eventsRef = useRef<HTMLDivElement | null>(null);

  // Close the event multi-select when clicking outside it.
  useEffect(() => {
    if (!eventsOpen) return;
    function onDown(e: MouseEvent) {
      if (eventsRef.current && !eventsRef.current.contains(e.target as Node)) {
        setEventsOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [eventsOpen]);

  function patch(p: Partial<AuditFilterState>) {
    onChange({ ...value, ...p });
  }

  function toggleEvent(name: string) {
    patch({
      eventNames: value.eventNames.includes(name)
        ? value.eventNames.filter((n) => n !== name)
        : [...value.eventNames, name],
    });
  }

  const activeCount =
    (value.eventNames.length > 0 ? 1 : 0) +
    (value.actorEmail.trim() ? 1 : 0) +
    (value.target.trim() ? 1 : 0) +
    (value.range !== DEFAULT_AUDIT_FILTERS.range ? 1 : 0);

  const body = (
    <div className="flex flex-col md:flex-row md:flex-wrap md:items-center gap-3">
      {/* Time range shortcuts */}
      <div
        className="inline-flex rounded-xl border border-[var(--border-subtle)] overflow-hidden self-start"
        role="group"
        aria-label="時間範圍"
      >
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            onClick={() => patch({ range: p.value })}
            data-testid={`range-${p.value}`}
            className={`px-3 h-11 md:h-9 text-xs whitespace-nowrap transition-colors ${
              value.range === p.value
                ? "bg-white/10 text-white"
                : "text-neutral-400 hover:text-white hover:bg-white/5"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {value.range === "custom" && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
          <input
            type="datetime-local"
            value={value.customSince}
            onChange={(e) => patch({ customSince: e.target.value })}
            className={`${inputCls} h-11 md:h-9`}
            data-testid="custom-since"
            aria-label="起始時間"
          />
          <span>—</span>
          <input
            type="datetime-local"
            value={value.customUntil}
            onChange={(e) => patch({ customUntil: e.target.value })}
            className={`${inputCls} h-11 md:h-9`}
            data-testid="custom-until"
            aria-label="結束時間"
          />
        </div>
      )}

      {/* Event name multi-select (grouped) */}
      <div className="relative" ref={eventsRef}>
        <button
          type="button"
          onClick={() => setEventsOpen((o) => !o)}
          data-testid="event-filter-toggle"
          aria-expanded={eventsOpen}
          className={`${inputCls} h-11 md:h-9 flex items-center gap-2 w-full md:w-auto ${
            value.eventNames.length > 0 ? "text-white" : "text-neutral-400"
          }`}
        >
          事件類型
          {value.eventNames.length > 0 && (
            <span className="px-1.5 rounded-full bg-[var(--accent-blue)]/20 text-[var(--accent-blue)] text-xs font-mono">
              {value.eventNames.length}
            </span>
          )}
          <span aria-hidden className="text-neutral-600">
            ▾
          </span>
        </button>
        {eventsOpen && (
          <div
            className="absolute z-30 mt-2 w-72 max-h-96 overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-neutral-950 shadow-xl p-3"
            data-testid="event-filter-panel"
          >
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs text-neutral-500">選事件（可多選）</span>
              {value.eventNames.length > 0 && (
                <button
                  type="button"
                  onClick={() => patch({ eventNames: [] })}
                  className="text-xs text-[var(--accent-blue)] hover:underline"
                >
                  清除
                </button>
              )}
            </div>
            {EVENT_GROUPS.map((g) => (
              <div key={g.label} className="mb-2 last:mb-0">
                <p className="text-[11px] uppercase text-neutral-600 mb-1">{g.label}</p>
                {g.events.map((name) => (
                  <label
                    key={name}
                    className="flex items-center gap-2 min-h-9 px-1 rounded-lg text-xs font-mono text-neutral-300 hover:bg-white/5 cursor-pointer select-none"
                  >
                    <input
                      type="checkbox"
                      checked={value.eventNames.includes(name)}
                      onChange={() => toggleEvent(name)}
                      className="accent-[var(--accent-blue)] w-4 h-4"
                      data-testid={`event-check-${name}`}
                    />
                    {name}
                  </label>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actor email autocomplete */}
      <input
        type="search"
        list="audit-actor-emails"
        value={value.actorEmail}
        onChange={(e) => patch({ actorEmail: e.target.value })}
        placeholder="操作者 email…"
        data-testid="actor-filter"
        className={`${inputCls} h-11 md:h-9 w-full md:w-52`}
      />
      <datalist id="audit-actor-emails">
        {(users ?? []).map((u) => (
          <option key={u.id} value={u.email} />
        ))}
      </datalist>

      {/* Target search */}
      <input
        type="search"
        value={value.target}
        onChange={(e) => patch({ target: e.target.value })}
        placeholder="Target（vehicle / user / lease id）…"
        data-testid="target-filter"
        className={`${inputCls} h-11 md:h-9 w-full md:w-60`}
      />

      {/* Live toggle */}
      <label className="inline-flex items-center gap-2 min-h-11 md:min-h-9 px-1 text-sm text-neutral-400 cursor-pointer select-none whitespace-nowrap">
        <input
          type="checkbox"
          checked={value.live}
          onChange={(e) => patch({ live: e.target.checked })}
          className="accent-emerald-400 w-4 h-4"
          data-testid="live-toggle"
        />
        <span className="inline-flex items-center gap-1.5">
          {value.live && (
            <span
              aria-hidden
              className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"
            />
          )}
          Live（5 秒）
        </span>
      </label>

      <div className="md:ml-auto">
        <Button
          variant="secondary"
          size="sm"
          onClick={onExport}
          disabled={exporting}
          data-testid="export-csv-btn"
          className="w-full md:w-auto"
        >
          {exporting ? "匯出中…" : "匯出 CSV"}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="mb-4">
      {/* Mobile: drawer toggle */}
      <button
        type="button"
        onClick={() => setMobileOpen((o) => !o)}
        data-testid="filter-drawer-toggle"
        aria-expanded={mobileOpen}
        className={`${inputCls} md:hidden h-11 w-full flex items-center justify-between text-neutral-300 mb-3`}
      >
        <span>
          篩選
          {activeCount > 0 && (
            <span className="ml-2 px-1.5 rounded-full bg-[var(--accent-blue)]/20 text-[var(--accent-blue)] text-xs font-mono">
              {activeCount}
            </span>
          )}
        </span>
        <span aria-hidden className="text-neutral-600">
          {mobileOpen ? "▴" : "▾"}
        </span>
      </button>
      <div className={mobileOpen ? "block" : "hidden md:block"}>{body}</div>
    </div>
  );
}
