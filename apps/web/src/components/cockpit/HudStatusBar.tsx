"use client";

import type { TelemetryMessage } from "@rvep/shared";

/**
 * L1 常駐 HUD — DJI FPV 風細字頂部 status bar。
 *
 * 永遠顯示三項：速度 / 電壓 / 連線延遲，色階按閾值切換綠/黃/紅。
 * 點擊整條 bar 展開 L2 TelemetryDrawer 看完整資料。
 *
 * 設計原則：
 * - 文字細、半透明、不擋視訊；高度 ≤ 36px
 * - 色彩=狀態語意（綠=正常、黃=注意、紅=危險）
 * - safe-area-inset-top 兼容 iPhone notch
 */

export interface HudStatusBarProps {
  telemetry: TelemetryMessage | null;
  staleMs: number;
  /** 連線狀態用：DataChannel latency proxy (last cmd ack ms or rtt). */
  connLatencyMs?: number | null;
  /** Click handler — expands TelemetryDrawer. */
  onExpand: () => void;
  /** Currently expanded? Affects chevron rotation. */
  expanded: boolean;
  /** Extra px to push the bar down (e.g. when SafetyBanner is occupying top). */
  topOffsetPx?: number;
}

export function HudStatusBar({
  telemetry,
  staleMs,
  connLatencyMs,
  onExpand,
  expanded,
  topOffsetPx = 0,
}: HudStatusBarProps) {
  const stale = staleMs > 1500;

  // ── Derived values ────────────────────────────────────────────
  const speedMs = telemetry?.velocity?.linearX ?? telemetry?.gps?.speedMs ?? null;
  const voltage = telemetry?.battery?.voltage ?? null;
  const batteryPct = telemetry?.battery?.pct ?? null;

  // ── Color thresholds (per spec) ───────────────────────────────
  // Voltage: >12V 綠 / 10.5-12 黃 / <10.5 紅
  const voltageTone =
    voltage == null
      ? "neutral"
      : voltage > 12
        ? "good"
        : voltage > 10.5
          ? "warn"
          : "bad";

  // Connection latency: <100ms 綠 / 100-300 黃 / >300 紅
  const connTone =
    connLatencyMs == null
      ? "neutral"
      : connLatencyMs < 100
        ? "good"
        : connLatencyMs < 300
          ? "warn"
          : "bad";

  // Speed: 永遠中性色（速度本身無危險閾值）
  const speedTone: Tone = "neutral";

  return (
    <button
      type="button"
      onClick={onExpand}
      data-testid="hud-status-bar"
      data-expanded={expanded ? "true" : undefined}
      aria-label={expanded ? "收起 telemetry 面板" : "展開 telemetry 面板"}
      aria-expanded={expanded}
      className={`
        pointer-events-auto fixed left-1/2 -translate-x-1/2 z-30
        flex items-center gap-4 px-4 py-1.5
        rounded-full border border-white/15 bg-black/55 backdrop-blur-md
        text-[11px] tracking-[0.08em] uppercase text-neutral-200
        transition-all duration-150
        hover:bg-black/70 hover:border-white/25 active:scale-[0.98]
        ${stale ? "opacity-60" : "opacity-100"}
      `}
      style={{
        top: `calc(max(0.5rem, env(safe-area-inset-top)) + ${topOffsetPx}px)`,
      }}
    >
      <Slot label="SPD" value={fmtSpeed(speedMs)} tone={speedTone} />
      <Divider />
      <Slot label="V" value={fmtVoltage(voltage, batteryPct)} tone={voltageTone} />
      <Divider />
      <Slot label="LINK" value={fmtLatency(connLatencyMs)} tone={connTone} />
      <span
        aria-hidden
        className={`ml-1 text-[10px] text-neutral-400 transition-transform duration-150 ${
          expanded ? "rotate-180" : ""
        }`}
      >
        ▾
      </span>
    </button>
  );
}

// ── Sub-components ────────────────────────────────────────────────

type Tone = "good" | "warn" | "bad" | "neutral";

const TONE_COLOR: Record<Tone, string> = {
  good: "#10b981",   // emerald
  warn: "#f59e0b",   // amber
  bad: "#ef4444",    // red
  neutral: "#d4d4d8" // neutral
};

function Slot({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <span className="flex items-center gap-1.5 cockpit tabular-nums normal-case">
      <span
        aria-hidden
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: TONE_COLOR[tone] }}
      />
      <span className="text-[9px] text-neutral-500 tracking-[0.16em] uppercase">{label}</span>
      <span
        className="font-semibold text-[12px] tracking-normal"
        style={{ color: TONE_COLOR[tone] }}
      >
        {value}
      </span>
    </span>
  );
}

function Divider() {
  return <span aria-hidden className="w-px h-3 bg-white/15" />;
}

// ── Formatters ────────────────────────────────────────────────────

function fmtSpeed(ms: number | null): string {
  if (ms == null) return "—";
  return `${ms.toFixed(1)} m/s`;
}

function fmtVoltage(v: number | null, pct: number | null): string {
  if (v == null && pct == null) return "—";
  if (v == null) return `${pct?.toFixed(0)}%`;
  return `${v.toFixed(1)}V`;
}

function fmtLatency(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
