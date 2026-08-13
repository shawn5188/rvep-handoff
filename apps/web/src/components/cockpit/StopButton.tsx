"use client";

import { useCallback, useRef, useState } from "react";

/**
 * Long-press emergency STOP button — DJI 風頂部中央獨立位置。
 *
 * 防誤觸機制：
 * - 必須按住 200ms 才觸發（emit onStop）
 * - 視覺進度條 0→100% 透過 CSS transition 實現
 * - 鬆手取消、cancel/leave 也取消
 * - 觸發後 800ms cooldown 顯示「STOPPED」回饋
 *
 * 設計細節：
 * - 永遠 100% 不透明、紅色，不會跟其他元件搶視線
 * - hit area 44×44 以上（iOS HIG）
 * - long-press 進度條從左到右填滿
 */

export interface StopButtonProps {
  onStop: () => void;
  /** ms to hold before emergency stop fires. 200ms = 防誤觸但仍快速反應. */
  holdMs?: number;
  /** When true, button is greyed out (rare — STOP should almost always be live). */
  disabled?: boolean;
}

export function StopButton({
  onStop,
  holdMs = 200,
  disabled = false,
}: StopButtonProps) {
  const [pressing, setPressing] = useState(false);
  const [recentlyFired, setRecentlyFired] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPressing(false);
  }, []);

  const fireStop = useCallback(() => {
    try {
      navigator.vibrate?.([60, 30, 60]);
    } catch {
      /* iOS Safari has no vibrate */
    }
    onStop();
    setPressing(false);
    setRecentlyFired(true);
    setTimeout(() => setRecentlyFired(false), 800);
  }, [onStop]);

  const handleDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (disabled) return;
      e.preventDefault();
      try {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* already captured */
      }
      setPressing(true);
      timerRef.current = setTimeout(fireStop, holdMs);
    },
    [disabled, holdMs, fireStop],
  );

  return (
    <button
      id="emergency-stop-btn"
      type="button"
      data-testid="emergency-stop"
      aria-label="緊急停止 — 按住 0.2 秒觸發"
      title="長按 0.2 秒緊急停止"
      onPointerDown={handleDown}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
      // Keyboard: Space/Enter — instant fire (accessibility)
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          fireStop();
        }
      }}
      disabled={disabled}
      className={`
        relative overflow-hidden pointer-events-auto
        flex items-center justify-center gap-2
        h-11 px-5 min-w-[112px]
        rounded-full font-bold uppercase tracking-[0.2em] text-[12px]
        select-none touch-none
        border-2 shadow-[0_0_30px_rgba(227,25,55,0.55)]
        transition-all duration-100
        ${
          recentlyFired
            ? "bg-white text-[var(--accent-red)] border-white scale-105"
            : "bg-[var(--accent-red)] text-white border-[var(--accent-red-dim)]"
        }
        ${pressing ? "scale-95" : "active:scale-95"}
        disabled:opacity-50 disabled:cursor-not-allowed
      `}
    >
      {/* Progress fill — CSS transition from 0 → 100% during press. */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 bg-white/30 pointer-events-none"
        style={{
          width: pressing ? "100%" : "0%",
          transition: pressing
            ? `width ${holdMs}ms linear`
            : "width 80ms ease-out",
        }}
      />
      <span className="relative z-[1] flex items-center gap-2">
        <span aria-hidden className="text-base leading-none">✕</span>
        <span>{recentlyFired ? "STOPPED" : "STOP"}</span>
      </span>
    </button>
  );
}
