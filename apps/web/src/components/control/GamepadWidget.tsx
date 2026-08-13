"use client";

/**
 * GamepadWidget — cockpit overlay showing Xbox 360 / generic gamepad state.
 *
 * Displays:
 *   - Connection status chip (connected / disconnected)
 *   - Mode badge (Dead-Man / Cruise + countdown / Safe Mode)
 *   - 4-circle stick visualizer (LX/LY left stick, RX/RY right stick)
 *   - Button lights (up to 12 buttons, row of filled circles)
 *   - LB (dead-man) hold indicator
 *
 * Spec: openspec/features/contract-c1-c8/c12-joystick-support.md
 *       openspec/safety/joystick-gates.md §Cockpit UI
 *       openspec/web/joystick-widget.md §3-§4
 */

import type { GamepadState } from "@/lib/hooks/useGamepad";

export interface GamepadWidgetProps {
  gamepad: GamepadState;
  /** When true, the widget is collapsed to a minimal status chip only. */
  compact?: boolean;
}

export function GamepadWidget({ gamepad, compact = false }: GamepadWidgetProps) {
  const { connected, gamepadName, axes, buttons, mode, cruiseRemainingS, deadManActive } =
    gamepad;

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Trim Gamepad API id to human-readable label. */
  function shortName(id: string): string {
    if (!id) return "Unknown";
    const m = id.match(/^([^(]+)/);
    return (m ? m[1] : id).trim().slice(0, 24);
  }

  const modeColor: Record<string, string> = {
    idle: "var(--fg-muted)",
    dead_man: deadManActive ? "var(--accent-green)" : "var(--accent-amber)",
    cruise: "var(--accent-blue, #60a5fa)",
    safe_mode: "var(--accent-red)",
  };

  const modeLabel: Record<string, string> = {
    idle: "IDLE",
    dead_man: deadManActive ? "DEAD-MAN ACTIVE" : "HOLD LB TO DRIVE",
    cruise: `CRUISE ${cruiseRemainingS}s`,
    safe_mode: "SAFE MODE (stuck detected)",
  };

  // ── Status chip (always visible) ─────────────────────────────────────────
  const chip = (
    <div
      data-testid="gamepad-chip"
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/70 border border-white/10 backdrop-blur text-[10px] tracking-[0.12em] uppercase"
    >
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: connected ? modeColor[mode] : "var(--fg-muted)" }}
        aria-hidden
      />
      <span
        className="text-neutral-300 truncate max-w-[160px]"
        title={connected ? gamepadName : "No gamepad"}
      >
        {connected ? shortName(gamepadName) : "No Gamepad"}
      </span>
      {connected && (
        <span style={{ color: modeColor[mode] }} className="ml-1 font-semibold">
          {modeLabel[mode]}
        </span>
      )}
    </div>
  );

  if (compact || !connected) return chip;

  // ── Stick visualizer (2 sticks = 4 circles) ──────────────────────────────
  // FIX 2026-06-06: Web Gamepad API standard layout: axes[0]=LX axes[1]=LY
  // axes[2]=RX axes[3]=RY. Sub-agent originally assumed 8-axis Linux raw layout
  // (axes[3]=RX axes[4]=RY) which Chrome doesn't expose. Standard 4-axis only.
  const lx = axes[0] ?? 0;
  const ly = axes[1] ?? 0;
  const rx = axes[2] ?? 0;
  const ry = axes[3] ?? 0;

  function StickViz({ x, y, label }: { x: number; y: number; label: string }) {
    const RADIUS = 20; // px from center
    const dotX = 50 + x * RADIUS;
    const dotY = 50 + y * RADIUS;
    const active = Math.abs(x) > 0.01 || Math.abs(y) > 0.01;
    return (
      <div className="flex flex-col items-center gap-1" data-testid={`stick-${label.toLowerCase()}`}>
        <svg
          width="44"
          height="44"
          viewBox="0 0 100 100"
          aria-label={`${label} stick x=${x.toFixed(2)} y=${y.toFixed(2)}`}
        >
          {/* Outer ring */}
          <circle
            cx="50"
            cy="50"
            r="45"
            fill="none"
            stroke="rgba(255,255,255,0.15)"
            strokeWidth="3"
          />
          {/* Center cross */}
          <line x1="50" y1="10" x2="50" y2="90" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
          <line x1="10" y1="50" x2="90" y2="50" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
          {/* Stick dot */}
          <circle
            cx={dotX}
            cy={dotY}
            r="10"
            fill={active ? "rgba(74, 222, 128, 0.9)" : "rgba(255,255,255,0.4)"}
          />
        </svg>
        <span className="text-[9px] tracking-[0.14em] text-neutral-500 uppercase">
          {label}
        </span>
      </div>
    );
  }

  // ── Button lights (up to 12) ──────────────────────────────────────────────
  const BTN_LABELS: Record<number, string> = {
    0: "A",
    1: "B",
    2: "X",
    3: "Y",
    4: "LB",
    5: "RB",
    6: "LT",
    7: "RT",
    8: "Sel",
    9: "St",
    10: "LS",
    11: "RS",
  };
  const BTN_COLORS: Record<number, string> = {
    0: "#4ade80", // A — green
    1: "#f87171", // B — red
    2: "#60a5fa", // X — blue
    3: "#facc15", // Y — yellow
    4: "#c084fc", // LB — purple (dead-man)
    5: "#fb923c", // RB — orange (cruise)
  };

  return (
    <div
      data-testid="gamepad-widget"
      className="flex flex-col gap-2 px-3 py-2.5 rounded-lg border border-white/10 bg-black/70 backdrop-blur text-[10px] tracking-[0.12em] uppercase"
    >
      {chip}

      {/* Mode banner (verbose) */}
      <div
        className="text-center font-semibold text-[10px] tracking-[0.18em]"
        style={{ color: modeColor[mode] }}
        data-testid="gamepad-mode-label"
        aria-live="polite"
        aria-atomic="true"
      >
        {modeLabel[mode]}
      </div>

      {/* Stick visualization */}
      <div className="flex items-center justify-center gap-4">
        <StickViz x={lx} y={ly} label="L" />
        <StickViz x={rx} y={ry} label="R" />
      </div>

      {/* Button lights */}
      <div className="flex flex-wrap gap-1 justify-center" data-testid="gamepad-buttons">
        {buttons.slice(0, 12).map((pressed, i) => (
          <div
            key={i}
            title={BTN_LABELS[i] ?? `B${i}`}
            aria-label={`Button ${BTN_LABELS[i] ?? i}: ${pressed ? "pressed" : "released"}`}
            className="flex flex-col items-center gap-0.5"
          >
            <div
              className="w-4 h-4 rounded-full border border-white/20 transition-colors duration-75"
              style={{
                background: pressed
                  ? (BTN_COLORS[i] ?? "rgba(255,255,255,0.8)")
                  : "rgba(255,255,255,0.08)",
              }}
            />
            <span className="text-[7px] text-neutral-600">
              {BTN_LABELS[i] ?? `${i}`}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
