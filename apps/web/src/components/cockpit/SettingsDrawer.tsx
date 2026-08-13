"use client";

import { useEffect } from "react";
import { CockpitModeSwitcher } from "@/components/control/CockpitModeSwitcher";
import { BrightnessToggle } from "@/components/control/BrightnessToggle";

/**
 * L3 settings drawer — 右側滑入面板，放 cockpit mode / brightness / fleet back / version。
 *
 * 收進這個 drawer 是因為設定不應該常駐占視訊版面。
 * 觸發：點頂部右上角齒輪按鈕（cockpit page 自帶）。
 *
 * 互動：
 * - Esc 或點背景關閉
 * - 半透明右側 sheet，260px 寬，置頂 z-30
 */

export interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  onBackToFleet: () => void;
  /** Operator identity / vehicle label info to display. */
  vehicleId: string;
  tileCount: number;
  stateLabel: string;
}

export function SettingsDrawer({
  open,
  onClose,
  onBackToFleet,
  vehicleId,
  tileCount,
  stateLabel,
}: SettingsDrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        data-testid="settings-drawer-backdrop"
        onClick={onClose}
        className="pointer-events-auto fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px]"
        aria-hidden
      />

      {/* Drawer panel — right-side slide-in */}
      <aside
        role="dialog"
        aria-label="駕駛艙設定"
        data-testid="settings-drawer"
        className="
          pointer-events-auto fixed top-0 right-0 bottom-0 z-40
          w-[min(320px,85vw)]
          border-l border-white/10 bg-neutral-950/95 backdrop-blur-xl
          shadow-2xl
          flex flex-col
          pt-[max(0.75rem,env(safe-area-inset-top))]
          pb-[max(0.75rem,env(safe-area-inset-bottom))]
          pr-[max(0.75rem,env(safe-area-inset-right))]
          pl-3
          animate-[settingsSlideIn_180ms_ease-out]
        "
        style={{
          animation: "settingsSlideIn 180ms ease-out",
        }}
      >
        <header className="flex items-center justify-between pb-3 border-b border-white/10">
          <h2 className="text-sm font-semibold tracking-[0.16em] uppercase text-neutral-200">
            駕駛艙設定
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉設定"
            className="h-8 w-8 rounded-full text-neutral-400 hover:bg-white/10 hover:text-white"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-auto py-4 space-y-5">
          {/* Vehicle info */}
          <section>
            <SectionLabel>載具資訊</SectionLabel>
            <dl className="text-[12px] cockpit space-y-1 mt-2">
              <Pair k="Vehicle" v={vehicleId} />
              <Pair k="Tiles" v={String(tileCount)} />
              <Pair k="State" v={stateLabel} />
            </dl>
          </section>

          {/* Cockpit mode */}
          <section>
            <SectionLabel>視覺密度</SectionLabel>
            <p className="text-[10px] text-neutral-500 mt-1 mb-2">
              Immersive 最少 UI、Standard 預設、Mission 含詳細遙測
            </p>
            <CockpitModeSwitcher />
          </section>

          {/* Brightness */}
          <section>
            <SectionLabel>亮度模式</SectionLabel>
            <p className="text-[10px] text-neutral-500 mt-1 mb-2">
              Auto / Outdoor 高對比 / Indoor 低眩光
            </p>
            <BrightnessToggle />
          </section>

          {/* Back to fleet */}
          <section>
            <SectionLabel>導航</SectionLabel>
            <button
              type="button"
              onClick={onBackToFleet}
              className="mt-2 w-full px-4 py-2.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-[12px] text-neutral-200 tracking-[0.1em] text-left transition"
              data-testid="settings-back-btn"
            >
              ← 回 Fleet 清單
            </button>
          </section>
        </div>

        <footer className="pt-3 border-t border-white/10 text-[9px] text-neutral-600 tracking-[0.12em]">
          RVEP Cockpit · DJI FPV redesign
        </footer>
      </aside>

      {/* Slide-in animation */}
      <style>{`
        @keyframes settingsSlideIn {
          from { transform: translateX(100%); }
          to   { transform: translateX(0); }
        }
      `}</style>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] uppercase tracking-[0.18em] text-neutral-400 font-semibold">
      {children}
    </h3>
  );
}

function Pair({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-neutral-500">{k}</span>
      <span className="text-neutral-200 tabular-nums truncate ml-2 max-w-[180px]" title={v}>
        {v}
      </span>
    </div>
  );
}
