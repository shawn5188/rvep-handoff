"use client";

import { useEffect } from "react";
import type { TelemetryMessage } from "@rvep/shared";
import type { ControlStats } from "@/lib/control-channel";

/**
 * L2 展開 telemetry drawer — 從頂部 status bar 點擊展開，覆蓋上半畫面。
 *
 * 顯示完整 telemetry：
 * - GPS（lat/lng/heading）
 * - Battery（pct/voltage/tempC）
 * - Network（rtt/jitter/up）
 * - Velocity（linear/angular）
 * - Odom（x/y/yaw）
 * - Sensors（extension map）
 * - Live control data（forward/lateral/yaw/rate/last cmd/total sent）
 *
 * 互動：
 * - Esc / 點背景 / 再點 status bar 收合
 * - 半透明背景 backdrop-blur，不全黑（駕駛仍要看得到視訊）
 * - iPad ≥1024px 顯示雙欄；iPhone 單欄
 */

export interface TelemetryDrawerProps {
  open: boolean;
  onClose: () => void;
  telemetry: TelemetryMessage | null;
  staleMs: number;
  /** Live control stats from ControlChannel.getStats(). */
  controlStats: ControlStats | null;
  /** True when WebRTC DataChannel is connected. */
  channelConnected: boolean;
  gamepadConnected: boolean;
  gamepadName?: string;
}

export function TelemetryDrawer({
  open,
  onClose,
  telemetry,
  staleMs,
  controlStats,
  channelConnected,
  gamepadConnected,
  gamepadName,
}: TelemetryDrawerProps) {
  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const stale = staleMs > 1500;

  return (
    <>
      {/* Backdrop — click to close, but only dimming top half */}
      <div
        data-testid="telemetry-drawer-backdrop"
        onClick={onClose}
        className="pointer-events-auto fixed inset-x-0 top-0 z-20 h-[55%] bg-black/30"
        aria-hidden
      />

      {/* Drawer panel — slides down from top */}
      <aside
        data-cockpit-layer="L2"
        data-testid="telemetry-drawer"
        role="dialog"
        aria-label="完整 telemetry 面板"
        className="
          pointer-events-auto fixed z-30
          left-1/2 -translate-x-1/2
          top-[calc(max(0.5rem,env(safe-area-inset-top))_+_2.75rem)]
          w-[min(720px,calc(100vw-1.5rem))]
          max-h-[calc(55vh-3rem)] overflow-auto
          rounded-2xl border border-white/15 bg-black/75 backdrop-blur-xl
          shadow-2xl
          animate-[fadeSlide_140ms_ease-out]
        "
        style={{
          animationName: "fadeSlide",
          animationDuration: "140ms",
          animationTimingFunction: "ease-out",
        }}
      >
        <header className="flex items-center justify-between px-4 py-2 border-b border-white/10 sticky top-0 bg-black/85 backdrop-blur z-10">
          <span className="text-[11px] uppercase tracking-[0.2em] text-neutral-300">
            Telemetry · seq {telemetry?.seq ?? "—"}
            {stale && <span className="ml-2 text-amber-400">stale {(staleMs / 1000).toFixed(1)}s</span>}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉"
            className="h-7 w-7 rounded-full text-neutral-400 hover:bg-white/10 hover:text-white text-sm"
          >
            ✕
          </button>
        </header>

        {/* Two-column on iPad+ (lg ≈ 1024px), single column on phone */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 p-3">
          {/* ── Live Control Data ── */}
          <Block title="Live Control" badge={channelConnected ? "ON-AIR" : "OFFLINE"} badgeTone={channelConnected ? "good" : "bad"}>
            {controlStats ? (
              <>
                <Row k="forward" v={controlStats.forward.toFixed(2)} unit="−1..1" />
                <Row k="lateral" v={controlStats.lateral.toFixed(2)} unit="−1..1" />
                <Row k="yaw" v={controlStats.yaw.toFixed(2)} unit="−1..1" />
                <Row k="rate" v={controlStats.rateHz.toString()} unit="Hz" tone={controlStats.rateHz > 0 ? "good" : "neutral"} />
                <Row
                  k="last cmd"
                  v={
                    controlStats.lastCmdAgoMs === Number.POSITIVE_INFINITY
                      ? "—"
                      : controlStats.lastCmdAgoMs < 1000
                        ? `${controlStats.lastCmdAgoMs.toFixed(0)} ms`
                        : `${(controlStats.lastCmdAgoMs / 1000).toFixed(1)} s`
                  }
                />
                <Row k="total sent" v={controlStats.totalCommands.toLocaleString()} />
                <Row
                  k="gamepad"
                  v={gamepadConnected ? shortName(gamepadName ?? "") : "— none"}
                  tone={gamepadConnected ? "good" : "neutral"}
                />
              </>
            ) : (
              <EmptyRow text="無控制通道" />
            )}
          </Block>

          {/* ── GPS ── */}
          <Block title="GPS">
            {telemetry?.gps ? (
              <>
                <Row k="緯度" v={fmtCoord(telemetry.gps.lat, "N", "S")} />
                <Row k="經度" v={fmtCoord(telemetry.gps.lng, "E", "W")} />
                <Row k="速度" v={`${(telemetry.gps.speedMs ?? 0).toFixed(1)} m/s`} />
                <Row k="方位" v={`${(telemetry.gps.headingDeg ?? 0).toFixed(0)}°`} />
              </>
            ) : (
              <EmptyRow text="無 GPS 訊號" />
            )}
          </Block>

          {/* ── Battery ── */}
          <Block title="Battery">
            {telemetry?.battery ? (
              <>
                <BatteryBar pct={telemetry.battery.pct} />
                <Row
                  k="電壓"
                  v={`${(telemetry.battery.voltage ?? 0).toFixed(1)} V`}
                  tone={voltageTone(telemetry.battery.voltage)}
                />
                <Row k="溫度" v={`${(telemetry.battery.tempC ?? 0).toFixed(0)} °C`} />
              </>
            ) : (
              <EmptyRow text="無資料" />
            )}
          </Block>

          {/* ── Network ── */}
          <Block title="Network">
            {telemetry?.network ? (
              <>
                <Row
                  k="RTT"
                  v={`${telemetry.network.rttMs.toFixed(0)} ms`}
                  tone={latencyTone(telemetry.network.rttMs)}
                />
                <Row k="抖動" v={`${(telemetry.network.jitterMs ?? 0).toFixed(1)} ms`} />
                <Row k="↑" v={`${((telemetry.network.kbpsUp ?? 0) / 1000).toFixed(1)} Mb/s`} />
              </>
            ) : (
              <EmptyRow text="無資料" />
            )}
          </Block>

          {/* ── Velocity (closed-loop feedback) ── */}
          {telemetry?.velocity && (
            <Block title="實際速度">
              <Row k="linear" v={`${telemetry.velocity.linearX.toFixed(2)} m/s`} />
              <Row k="angular" v={`${telemetry.velocity.angularZ.toFixed(2)} rad/s`} />
            </Block>
          )}

          {/* ── Odom pose ── */}
          {telemetry?.odom && (
            <Block title="位置">
              <Row k="x,y" v={`(${telemetry.odom.x.toFixed(2)}, ${telemetry.odom.y.toFixed(2)})`} />
              <Row k="yaw" v={`${((telemetry.odom.yaw * 180) / Math.PI).toFixed(0)}°`} />
            </Block>
          )}

          {/* ── Vehicle mode ── */}
          {telemetry?.vehicle && (
            <Block title="狀態">
              <Row
                k="模式"
                v={modeLabel(telemetry.vehicle.mode)}
                tone={
                  telemetry.vehicle.mode === "manual"
                    ? "good"
                    : telemetry.vehicle.mode === "safe"
                      ? "warn"
                      : "neutral"
                }
              />
            </Block>
          )}

          {/* ── Extension sensors ── */}
          {telemetry?.sensors && Object.keys(telemetry.sensors).length > 0 && (
            <Block title="其他感測" span={2}>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                {Object.entries(telemetry.sensors).slice(0, 12).map(([key, val]) => (
                  <Row
                    key={key}
                    k={key.length > 18 ? key.slice(0, 16) + "…" : key}
                    v={fmtSensorValue(val)}
                  />
                ))}
              </div>
              {Object.keys(telemetry.sensors).length > 12 && (
                <div className="text-[9px] text-neutral-600 text-right mt-1">
                  … +{Object.keys(telemetry.sensors).length - 12} 項
                </div>
              )}
            </Block>
          )}
        </div>
      </aside>

      {/* Fade+slide entry animation — global keyframes injected via <style> tag */}
      <style>{`
        @keyframes fadeSlide {
          from { opacity: 0; transform: translate(-50%, -8px); }
          to   { opacity: 1; transform: translate(-50%, 0); }
        }
      `}</style>
    </>
  );
}

// ── Building blocks ──────────────────────────────────────────────

type Tone = "good" | "warn" | "bad" | "neutral";
const TONE_COLOR: Record<Tone, string> = {
  good: "#10b981",
  warn: "#f59e0b",
  bad: "#ef4444",
  neutral: "#d4d4d8",
};

function Block({
  title,
  badge,
  badgeTone,
  span = 1,
  children,
}: {
  title: string;
  badge?: string;
  badgeTone?: Tone;
  span?: 1 | 2;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`rounded-lg border border-white/10 bg-black/40 p-2.5 ${
        span === 2 ? "lg:col-span-2" : ""
      }`}
    >
      <header className="flex items-center justify-between mb-1.5">
        <h3 className="text-[10px] uppercase tracking-[0.18em] text-neutral-400 font-semibold">
          {title}
        </h3>
        {badge && (
          <span
            className="text-[9px] tracking-[0.16em] font-semibold uppercase"
            style={{ color: TONE_COLOR[badgeTone ?? "neutral"] }}
          >
            {badge}
          </span>
        )}
      </header>
      <div className="space-y-0.5 cockpit tabular-nums text-[11px]">{children}</div>
    </section>
  );
}

function Row({
  k,
  v,
  unit,
  tone = "neutral",
}: {
  k: string;
  v: string;
  unit?: string;
  tone?: Tone;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-neutral-200">
      <span className="text-neutral-500 text-[10px] uppercase tracking-[0.1em] min-w-[60px]">
        {k}
      </span>
      <span className="font-medium" style={{ color: TONE_COLOR[tone] }}>
        {v}
        {unit && <span className="text-[9px] text-neutral-500 ml-1">{unit}</span>}
      </span>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="text-[10px] text-neutral-500 italic">{text}</div>;
}

function BatteryBar({ pct }: { pct: number }) {
  const color = pct > 50 ? "bg-emerald-500" : pct > 20 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2 mb-1">
      <div className="flex-1 h-1.5 bg-neutral-800 rounded-sm overflow-hidden">
        <div className={`h-full ${color} transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-neutral-200 min-w-[36px] text-right text-[11px]">
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────

function fmtSensorValue(v: unknown): string {
  if (typeof v === "number") return v.toFixed(2);
  if (typeof v === "boolean") return v ? "✓" : "✗";
  if (v === null) return "—";
  if (typeof v === "string") return v.length > 14 ? v.slice(0, 12) + "…" : v;
  return JSON.stringify(v).slice(0, 14);
}

function fmtCoord(v: number, pos: string, neg: string) {
  const abs = Math.abs(v);
  return `${abs.toFixed(5)}°${v >= 0 ? pos : neg}`;
}

function modeLabel(m: "manual" | "safe" | "off" | "calibrating") {
  return { manual: "手動駕駛", safe: "安全模式", off: "離線", calibrating: "校正中" }[m];
}

function voltageTone(v: number | undefined): Tone {
  if (v == null) return "neutral";
  if (v > 12) return "good";
  if (v > 10.5) return "warn";
  return "bad";
}

function latencyTone(ms: number): Tone {
  if (ms < 100) return "good";
  if (ms < 300) return "warn";
  return "bad";
}

function shortName(id: string): string {
  if (!id) return "—";
  const m = id.match(/^([^(]+)/);
  return (m ? m[1] : id).trim().slice(0, 18);
}
