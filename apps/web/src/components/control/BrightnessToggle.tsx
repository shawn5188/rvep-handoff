"use client";

import {
  useCockpitStore,
  type Brightness,
} from "@/lib/stores/cockpit-store";
import { useHydrated } from "@/lib/hooks/useHydrated";

const OPTIONS: { id: Brightness; label: string; glyph: string; hint: string }[] = [
  { id: "auto", label: "Auto", glyph: "◐", hint: "依環境光自動調整" },
  { id: "outdoor", label: "Outdoor", glyph: "☀", hint: "戶外強光：高對比 + 大字" },
  { id: "indoor", label: "Indoor", glyph: "☾", hint: "室內：低亮度避免眩光" },
];

/** Cycles brightness profile on each click. */
export function BrightnessToggle() {
  const hydrated = useHydrated();
  const brightness = useCockpitStore((s) => s.brightness);
  const setBrightness = useCockpitStore((s) => s.setBrightness);
  // Use SSR-stable default until Zustand persist rehydrates from localStorage.
  const safeBrightness: Brightness = hydrated ? brightness : "auto";

  const idx = OPTIONS.findIndex((o) => o.id === safeBrightness);
  const current = OPTIONS[Math.max(0, idx)];

  return (
    <button
      type="button"
      onClick={() => setBrightness(OPTIONS[(idx + 1) % OPTIONS.length].id)}
      title={`${current.label} · ${current.hint} · 點擊切換`}
      data-testid="brightness-toggle"
      data-brightness={current.id}
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[var(--border-subtle)] bg-black/40 backdrop-blur text-[11px] uppercase tracking-widest text-neutral-300 hover:text-white hover:border-[var(--border-strong)] transition-colors"
    >
      <span className="text-base leading-none">{current.glyph}</span>
      <span>{current.label}</span>
    </button>
  );
}
