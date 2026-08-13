"use client";

import { useEffect } from "react";
import {
  useCockpitStore,
  type CockpitMode,
} from "@/lib/stores/cockpit-store";
import { useHydrated } from "@/lib/hooks/useHydrated";

const MODES: { id: CockpitMode; label: string; key: string; hint: string }[] = [
  { id: "immersive", label: "Immersive", key: "1", hint: "全螢幕影像，最少干擾" },
  { id: "standard", label: "Standard", key: "2", hint: "預設駕駛艙：HUD + 工具列" },
  { id: "mission", label: "Mission", key: "3", hint: "任務模式：含詳細遙測面板" },
];

/** Keyboard shortcut requires Alt modifier to prevent accidental mode switches. */
const ALT_MODIFIER = true;

interface Props {
  /** Disable shortcuts while typing in a form field, etc. */
  shortcutsEnabled?: boolean;
}

/**
 * Three-position segmented control for cockpit visual density.
 * Keyboard: 1 / 2 / 3 jump to Immersive / Standard / Mission.
 */
export function CockpitModeSwitcher({ shortcutsEnabled = true }: Props) {
  const hydrated = useHydrated();
  const mode = useCockpitStore((s) => s.mode);
  const setMode = useCockpitStore((s) => s.setMode);
  // Use SSR-stable default until Zustand persist rehydrates from localStorage.
  const safeMode: CockpitMode = hydrated ? mode : "standard";

  useEffect(() => {
    if (!shortcutsEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      // Ignore shortcuts while typing.
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      ) {
        return;
      }
      // Alt+1/2/3 required to prevent accidental mode switches (P0-8).
      if (ALT_MODIFIER && !e.altKey) return;
      const hit = MODES.find((m) => m.key === e.key);
      if (hit) {
        e.preventDefault(); // prevent browser from opening menus on Alt+digit
        setMode(hit.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcutsEnabled, setMode]);

  return (
    <div
      role="radiogroup"
      aria-label="駕駛艙模式"
      data-testid="mode-switcher"
      className="inline-flex items-center rounded-full border border-[var(--border-subtle)] bg-black/40 backdrop-blur px-0.5 py-0.5 gap-0.5"
    >
      {MODES.map((m) => {
        const selected = safeMode === m.id;
        return (
          <button
            key={m.id}
            role="radio"
            aria-checked={selected}
            title={`${m.label} · ${m.hint} · 快捷鍵 Alt+${m.key}`}
            onClick={() => setMode(m.id)}
            data-testid={`mode-${m.id}`}
            data-selected={selected ? "true" : undefined}
            className={`px-3 py-1 text-[11px] tracking-widest uppercase rounded-full transition-colors ${
              selected
                ? "bg-white/15 text-white"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
