"use client";

import { useEffect, useRef, useState } from "react";

type Axes = { forward: number; lateral: number; yaw: number };

interface Props {
  /** Called at 8 Hz while a button is held (same cadence as Joystick). */
  onPress: (axes: Axes) => void;
  /** Called once when the held button is released / cancelled. */
  onRelease: () => void;
  /** When true, all buttons are greyed out and pointer events ignored. */
  disabled?: boolean;
}

const ZERO: Axes = { forward: 0, lateral: 0, yaw: 0 };

/**
 * MOBA-style (傳說對決) right-thumb action cluster:
 * one large primary button (前進) at the bottom-right corner plus an arc of
 * three smaller buttons above it (後退 / 左轉 / 右轉).
 *
 * Layout: the small buttons sit on a quarter-circle of radius ~5.5rem around
 * the big button center, so the whole cluster is reachable without moving the
 * right hand — mirroring the Joystick under the left thumb.
 */
const BUTTONS: Array<{
  id: number;
  label: string;
  glyph: string;
  axes: Axes;
  size: "lg" | "sm";
  /** offset of button center from the big-button center, in rem (x→left, y→up) */
  dx: number;
  dy: number;
}> = [
  { id: 1, label: "前進", glyph: "▲", axes: { forward: 1, lateral: 0, yaw: 0 }, size: "lg", dx: 0, dy: 0 },
  { id: 2, label: "後退", glyph: "▼", axes: { forward: -1, lateral: 0, yaw: 0 }, size: "sm", dx: 5.5, dy: 0 },
  { id: 3, label: "左轉", glyph: "⟲", axes: { forward: 0, lateral: 0, yaw: -1 }, size: "sm", dx: 3.9, dy: 3.9 },
  { id: 4, label: "右轉", glyph: "⟳", axes: { forward: 0, lateral: 0, yaw: 1 }, size: "sm", dx: 0, dy: 5.5 },
];

export function ActionButtons({ onPress, onRelease, disabled = false }: Props) {
  const [activeId, setActiveId] = useState<number | null>(null);
  const axesRef = useRef<Axes>(ZERO);
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;
  const onReleaseRef = useRef(onRelease);
  onReleaseRef.current = onRelease;

  // 8 Hz repeat while held — matches Joystick cadence so the vehicle-side
  // command watchdog never times out mid-press.
  useEffect(() => {
    if (activeId == null) return;
    onPressRef.current(axesRef.current);
    const interval = setInterval(() => {
      onPressRef.current(axesRef.current);
    }, 125);
    return () => clearInterval(interval);
  }, [activeId]);

  // Safety: if the component unmounts (or gets disabled) mid-press, zero out.
  useEffect(() => {
    if (disabled && activeId != null) {
      setActiveId(null);
      onReleaseRef.current();
    }
  }, [disabled, activeId]);

  function start(id: number, axes: Axes) {
    axesRef.current = axes;
    setActiveId(id);
    try {
      navigator.vibrate?.(10);
    } catch {
      // iOS Safari lacks vibrate; ignore.
    }
  }

  function end() {
    if (activeId == null) return;
    setActiveId(null);
    onReleaseRef.current();
  }

  return (
    <div
      data-testid="action-buttons"
      className="relative select-none"
      style={{ width: "12rem", height: "12rem" }}
    >
      {BUTTONS.map((b) => {
        const isLg = b.size === "lg";
        const dia = isLg ? "6rem" : "3.5rem";
        const active = activeId === b.id;
        return (
          <button
            key={b.id}
            type="button"
            data-testid={`action-btn-${b.id}`}
            aria-label={b.label}
            title={b.label}
            disabled={disabled}
            onPointerDown={
              disabled
                ? undefined
                : (e) => {
                    (e.target as HTMLElement).setPointerCapture(e.pointerId);
                    start(b.id, b.axes);
                  }
            }
            onPointerUp={disabled ? undefined : end}
            onPointerCancel={disabled ? undefined : end}
            onPointerLeave={disabled ? undefined : end}
            className={`
              absolute rounded-full touch-none flex flex-col items-center justify-center
              border-2 backdrop-blur-md transition-colors
              ${
                disabled
                  ? "cursor-not-allowed border-white/15 bg-black/30 opacity-60"
                  : active
                    ? "border-white/70 bg-white/20 shadow-[0_0_26px_rgba(255,255,255,0.35)]"
                    : "border-white/35 bg-black/40 hover:bg-black/55 active:scale-95"
              }
            `}
            style={{
              width: dia,
              height: dia,
              right: `calc(3rem - ${dia} / 2 + ${b.dx}rem)`,
              bottom: `calc(3rem - ${dia} / 2 + ${b.dy}rem)`,
            }}
          >
            <span className={`${isLg ? "text-3xl" : "text-lg"} leading-none text-white/90`} aria-hidden>
              {b.glyph}
            </span>
            <span className={`${isLg ? "text-[11px] mt-1" : "text-[9px]"} text-white/60 leading-none`} aria-hidden>
              {b.id}
            </span>
          </button>
        );
      })}
    </div>
  );
}
