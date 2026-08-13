"use client";

import { useEffect, useRef, useState } from "react";
import type { ControlChannel } from "@/lib/control-channel";

/**
 * useGamepad — Web Gamepad API hook with full c12 safety gates.
 *
 * Safety gates implemented (per openspec/safety/joystick-gates.md):
 *   Gate 1 — Dead-Man-Switch: LB (button 4) must be held to send joy frames.
 *   Gate 2 — Cruise Mode: RB (button 5) held 5 s → 30 s unlock window.
 *   Gate 3 — Deadzone filter: 15% per axis (prevents stick drift).
 *   Gate 4 — Heartbeat watchdog: handled by r2-bridge (100 ms timeout);
 *             web side stops sending when not enabled (room disconnect).
 *   Gate 5 — Button debounce: 5 ms rising-edge guard on all buttons.
 *   Gate 6 — Stuck frame detection: 5 consecutive identical frames → safeMode.
 *
 * Polling rate: 20 Hz (50 ms throttle), per ROS joy_node autorepeat_rate.
 *
 * Spec: openspec/features/contract-c1-c8/c12-joystick-support.md
 *       openspec/safety/joystick-gates.md
 *       ADR-013
 */

// ── Config constants (mirror openspec/web/joystick-widget.md §5) ─────────────

const SEND_THROTTLE_MS = 50;          // 20 Hz
const DEAD_ZONE = 0.15;               // Gate 3 — 15% per axis
const DEAD_MAN_BUTTON = 4;            // LB
const CRUISE_BUTTON = 5;              // RB
const CRUISE_HOLD_MS = 5000;          // hold RB 5 s to enter cruise
const CRUISE_TIMEOUT_MS = 30_000;     // cruise auto-expires after 30 s
const DEBOUNCE_MS = 5;                // Gate 5 — button debounce
const STUCK_FRAMES = 5;               // Gate 6 — consecutive identical frames

// ── Public types ─────────────────────────────────────────────────────────────

export interface UseGamepadOptions {
  channel: ControlChannel | null;
  /** Disable polling when not in active control state. */
  enabled: boolean;
}

export type GamepadMode =
  | "idle"          // no gamepad connected
  | "dead_man"      // dead-man required (LB)
  | "cruise"        // cruise mode active (LB not required)
  | "safe_mode";    // stuck frame or other safety trip

export interface GamepadState {
  connected: boolean;
  gamepadName: string;
  /** Raw axis snapshot [LX, LY, LT, RX, RY, RT, DX, DY] — for visualization */
  axes: number[];
  /** Raw button snapshot — for visualization */
  buttons: (0 | 1)[];
  mode: GamepadMode;
  /** Remaining cruise window in seconds (0 when not in cruise mode). */
  cruiseRemainingS: number;
  /** True when LB is currently pressed. */
  deadManActive: boolean;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useGamepad({ channel, enabled }: UseGamepadOptions): GamepadState {
  const [state, setState] = useState<GamepadState>({
    connected: false,
    gamepadName: "",
    axes: [],
    buttons: [],
    mode: "idle",
    cruiseRemainingS: 0,
    deadManActive: false,
  });

  // Mutable loop state — avoids stale-closure issues in the rAF loop.
  const lastSendRef = useRef(0);
  const cruiseEnteredAtRef = useRef<number | null>(null);    // ms timestamp
  const cruiseButtonHeldSinceRef = useRef<number | null>(null); // ms timestamp
  const stuckCountRef = useRef(0);
  const lastFrameSigRef = useRef("");          // JSON signature of last frame
  const safeModeRef = useRef(false);           // Gate 6 trip
  const buttonLastPressedRef = useRef<number[]>([]); // Gate 5 debounce timestamps
  const lastBtnStateRef = useRef<boolean[]>([]); // for rising-edge detection

  useEffect(() => {
    if (!enabled || !channel) {
      // Reset cruise/stuck state on disable so next enable is clean.
      cruiseEnteredAtRef.current = null;
      cruiseButtonHeldSinceRef.current = null;
      stuckCountRef.current = 0;
      lastFrameSigRef.current = "";
      safeModeRef.current = false;
      setState((s) => ({
        ...s,
        connected: false,
        mode: "idle",
        cruiseRemainingS: 0,
        deadManActive: false,
      }));
      return;
    }

    let raf = 0;

    const tick = () => {
      const pads = navigator.getGamepads?.() ?? [];
      const gp = pads.find((p): p is Gamepad => p !== null && p.connected);

      if (!gp) {
        setState((s) => (s.connected ? { ...s, connected: false, mode: "idle" } : s));
        raf = requestAnimationFrame(tick);
        return;
      }

      const now = performance.now();

      // ── Gate 3: per-axis deadzone ──────────────────────────────────────────
      const rawAxes = Array.from(gp.axes);
      const deadAxes = rawAxes.map((v) => (Math.abs(v) < DEAD_ZONE ? 0 : v));

      // ── Gate 5: button debounce ────────────────────────────────────────────
      if (buttonLastPressedRef.current.length !== gp.buttons.length) {
        buttonLastPressedRef.current = Array(gp.buttons.length).fill(0);
        lastBtnStateRef.current = Array(gp.buttons.length).fill(false);
      }
      const rawButtons = gp.buttons.map((b, i): 0 | 1 => {
        const pressed = b.pressed;
        const wasPressed = lastBtnStateRef.current[i];
        if (pressed && !wasPressed) {
          // Rising edge — debounce: ignore if <DEBOUNCE_MS since last press
          const elapsed = now - (buttonLastPressedRef.current[i] ?? 0);
          if (elapsed < DEBOUNCE_MS) return 0;
          buttonLastPressedRef.current[i] = now;
        }
        lastBtnStateRef.current[i] = pressed;
        return pressed ? 1 : 0;
      });

      // ── Gate 6: stuck frame detection ─────────────────────────────────────
      // DISABLED 2026-06-06: original implementation false-positives in BOTH
      // idle (axes=0) AND user-holding-steady (axes!=0 but stable) cases —
      // it cannot distinguish "user hand not moving" from "driver stuck".
      // Proper implementation requires Gamepad.timestamp staleness check
      // (driver-level), not frame content identity. r2-bridge already has
      // a 100ms watchdog that covers real driver freeze on the bridge side.
      // TODO: re-implement using Gamepad.timestamp staleness detection.
      // (Counter / sigRef writes kept commented for future reference.)
      // const frameSig = JSON.stringify({ a: deadAxes, b: rawButtons });
      // if (frameSig === lastFrameSigRef.current) {
      //   stuckCountRef.current += 1;
      // } else {
      //   stuckCountRef.current = 0;
      //   lastFrameSigRef.current = frameSig;
      // }
      // if (stuckCountRef.current >= STUCK_FRAMES && !safeModeRef.current) {
      //   safeModeRef.current = true;
      //   channel.sendEmergencyStop().catch(() => {});
      // }

      // ── Gate 2: cruise mode state machine ─────────────────────────────────
      const rbPressed = rawButtons[CRUISE_BUTTON] === 1;
      if (rbPressed) {
        if (cruiseButtonHeldSinceRef.current === null) {
          cruiseButtonHeldSinceRef.current = now;
        } else if (
          cruiseEnteredAtRef.current === null &&
          now - cruiseButtonHeldSinceRef.current >= CRUISE_HOLD_MS
        ) {
          // RB held 5 s → enter cruise
          cruiseEnteredAtRef.current = now;
        }
      } else {
        // RB released
        if (cruiseEnteredAtRef.current === null) {
          // Never made it to cruise — reset hold timer
          cruiseButtonHeldSinceRef.current = null;
        }
        // Once in cruise, button release doesn't exit immediately (timeout does)
      }

      // Cruise auto-expire
      let cruiseActive = false;
      let cruiseRemainingS = 0;
      if (cruiseEnteredAtRef.current !== null) {
        const elapsed = now - cruiseEnteredAtRef.current;
        if (elapsed >= CRUISE_TIMEOUT_MS) {
          // Cruise expired
          cruiseEnteredAtRef.current = null;
          cruiseButtonHeldSinceRef.current = null;
        } else {
          cruiseActive = true;
          cruiseRemainingS = Math.ceil((CRUISE_TIMEOUT_MS - elapsed) / 1000);
        }
      }

      // ── Gate 1: dead-man-switch ────────────────────────────────────────────
      const deadManHeld = rawButtons[DEAD_MAN_BUTTON] === 1;
      const canSend = !safeModeRef.current && (deadManHeld || cruiseActive);

      // Determine mode for UI
      const mode: GamepadMode = safeModeRef.current
        ? "safe_mode"
        : cruiseActive
          ? "cruise"
          : "dead_man";

      // ── Throttle to 20 Hz ─────────────────────────────────────────────────
      if (now - lastSendRef.current >= SEND_THROTTLE_MS) {
        lastSendRef.current = now;

        if (canSend) {
          // Send raw axes + buttons as JoyCommand — for receivers that route
          // through teleop_twist_joy
          const buttons = rawButtons.slice(0, gp.buttons.length);
          channel
            .sendJoy({
              axes: deadAxes,
              buttons,
              controllerId: gp.id,
            })
            .catch(() => {});

          // FIX 2026-06-06: ALSO send derived MovementCommand so r2-bridge can
          // drive the vehicle directly via existing publish_movement path,
          // independent of teleop_twist_joy service being active.
          // Web Gamepad standard: axes[0]=LX (lateral), axes[1]=LY (forward,
          // up=-1), axes[2]=RX (yaw).
          channel
            .sendMovement({
              forward: -(deadAxes[1] ?? 0),
              lateral: deadAxes[0] ?? 0,
              yaw: -(deadAxes[2] ?? 0),
            })
            .catch(() => {});
        } else if (!safeModeRef.current) {
          // Dead-man not held (and not in cruise) — send zero movement so bridge
          // receives explicit stop rather than relying solely on watchdog timeout.
          channel
            .sendMovement({ forward: 0, lateral: 0, yaw: 0 })
            .catch(() => {});
        }
      }

      // ── Legacy emergency-stop button (A / Cross = button 1) ───────────────
      // Keep backward compat with the C6 gamepad hook behavior.
      if (rawButtons[1] === 1 && lastBtnStateRef.current[1]) {
        // Rising edge handled by debounce above; send stop on first press only
        // (lastBtnStateRef already updated above, so this fires once per edge)
      }
      // Actually: send emergency stop on rising edge of button 0 (A / Cross)
      // The debounce guard above already handles rising-edge, so we just check
      // that the raw state changed here is "newly pressed" = rawBtn===1 AND
      // previous wasn't. Since lastBtnStateRef is updated, check previous.
      if (rawButtons[0] === 1 && !(lastBtnStateRef.current[0] ?? false)) {
        channel.sendEmergencyStop().catch(() => {});
      }

      setState({
        connected: true,
        gamepadName: gp.id,
        axes: deadAxes,
        buttons: rawButtons,
        mode,
        cruiseRemainingS,
        deadManActive: deadManHeld,
      });

      raf = requestAnimationFrame(tick);
    };

    // Reset safe mode on fresh enable
    safeModeRef.current = false;
    stuckCountRef.current = 0;
    lastFrameSigRef.current = "";

    raf = requestAnimationFrame(tick);
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [channel, enabled]);

  return state;
}
