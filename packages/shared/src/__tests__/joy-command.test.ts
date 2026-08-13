/**
 * Unit tests for JoyCommand schema + encode/decode helpers.
 *
 * Spec: openspec/features/contract-c1-c8/c12-joystick-support.md §Schema
 *       openspec/safety/joystick-gates.md Gate 3 (deadzone), Gate 5 (debounce)
 */
import { describe, it, expect } from "vitest";
import {
  JoyCommand,
  ControlCommand,
  encodeJoy,
  decodeJoy,
  encodeCommand,
  decodeCommand,
} from "../control-commands";

// ── fixtures ────────────────────────────────────────────────────────────────

const BASE = {
  vehicleId: "r2-001",
  sessionId: "web-1234567890",
  connectionEpoch: 1717600000000,
  seq: 1,
  timestamp: "2026-06-05T08:00:00.000Z",
};

const MINIMAL_JOY = {
  type: "joy" as const,
  ...BASE,
  joy: {
    axes: [0, 0, 0, 0, 0, 0, 0, 0],
    buttons: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as (0 | 1)[],
    controllerId: "Xbox 360 Controller (XInput STANDARD GAMEPAD)",
  },
};

const ACTIVE_JOY = {
  ...MINIMAL_JOY,
  joy: {
    axes: [0, -0.8, 0, 0.5, 0, 0, 0, 0],
    buttons: [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0] as (0 | 1)[], // LB pressed (index 4)
    controllerId: "Xbox 360 Controller (XInput STANDARD GAMEPAD)",
  },
  sourceHealth: "ACTIVE" as const,
};

// ── Schema validation ────────────────────────────────────────────────────────

describe("JoyCommand schema", () => {
  it("accepts a minimal zero-input frame", () => {
    const result = JoyCommand.safeParse(MINIMAL_JOY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("joy");
      expect(result.data.joy.axes).toHaveLength(8);
      expect(result.data.joy.buttons).toHaveLength(11);
    }
  });

  it("accepts an active frame with LB held (dead-man) + sourceHealth", () => {
    const result = JoyCommand.safeParse(ACTIVE_JOY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sourceHealth).toBe("ACTIVE");
      expect(result.data.joy.buttons[4]).toBe(1); // LB = dead-man-switch
    }
  });

  it("rejects axis values outside [-1, 1]", () => {
    const bad = {
      ...MINIMAL_JOY,
      joy: { ...MINIMAL_JOY.joy, axes: [0, 1.5, 0, 0, 0, 0, 0, 0] },
    };
    const result = JoyCommand.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects button values outside {0, 1}", () => {
    const bad = {
      ...MINIMAL_JOY,
      joy: {
        ...MINIMAL_JOY.joy,
        buttons: [0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0], // 2 is invalid
      },
    };
    const result = JoyCommand.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("allows empty axes / buttons arrays (variable-length gamepad)", () => {
    // Some gamepads expose fewer axes — schema does not enforce length.
    const slim = {
      ...MINIMAL_JOY,
      joy: { axes: [] as number[], buttons: [] as (0 | 1)[], controllerId: "Generic" },
    };
    const result = JoyCommand.safeParse(slim);
    expect(result.success).toBe(true);
  });

  it("rejects missing type discriminator", () => {
    const { type: _t, ...noType } = MINIMAL_JOY;
    const result = JoyCommand.safeParse(noType);
    expect(result.success).toBe(false);
  });

  it("rejects wrong type discriminator", () => {
    const result = JoyCommand.safeParse({ ...MINIMAL_JOY, type: "movement" });
    expect(result.success).toBe(false);
  });

  it("allows optional sourceHealth to be absent", () => {
    const result = JoyCommand.safeParse(MINIMAL_JOY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sourceHealth).toBeUndefined();
    }
  });

  it("rejects unknown sourceHealth value", () => {
    const result = JoyCommand.safeParse({ ...MINIMAL_JOY, sourceHealth: "INVALID" });
    expect(result.success).toBe(false);
  });

  it("accepts all valid sourceHealth enum values", () => {
    const values = ["ACTIVE", "LOW_FREQ", "TIMEOUT", "DISCONNECTED", "UNKNOWN"] as const;
    for (const v of values) {
      const r = JoyCommand.safeParse({ ...MINIMAL_JOY, sourceHealth: v });
      expect(r.success, `sourceHealth=${v} should be valid`).toBe(true);
    }
  });
});

// ── ControlCommand discriminated union ──────────────────────────────────────

describe("ControlCommand union includes JoyCommand", () => {
  it("parses type='joy' through ControlCommand union", () => {
    const result = ControlCommand.safeParse(ACTIVE_JOY);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe("joy");
    }
  });

  it("does not break existing movement type parsing", () => {
    const movement = {
      type: "movement",
      ...BASE,
      axes: { forward: 0.5, lateral: 0, yaw: -0.3 },
    };
    const result = ControlCommand.safeParse(movement);
    expect(result.success).toBe(true);
  });
});

// ── encode / decode helpers ──────────────────────────────────────────────────

describe("encodeJoy / decodeJoy round-trip", () => {
  it("encodes and decodes a minimal joy frame", () => {
    // JoyCommand.parse will throw if MINIMAL_JOY is invalid — acts as guard
    const cmd = JoyCommand.parse(MINIMAL_JOY);
    const bytes = encodeJoy(cmd);
    expect(bytes).toBeInstanceOf(Uint8Array);

    const decoded = decodeJoy(bytes);
    expect(decoded).not.toBeNull();
    expect(decoded?.type).toBe("joy");
    expect(decoded?.joy.controllerId).toBe(MINIMAL_JOY.joy.controllerId);
  });

  it("encodes and decodes an active joy frame preserving all fields", () => {
    const cmd = JoyCommand.parse(ACTIVE_JOY);
    const bytes = encodeJoy(cmd);
    const decoded = decodeJoy(bytes);

    expect(decoded?.sourceHealth).toBe("ACTIVE");
    expect(decoded?.joy.buttons[4]).toBe(1);
    expect(decoded?.joy.axes[1]).toBeCloseTo(-0.8);
  });

  it("decodeJoy returns null on malformed bytes", () => {
    const bad = new TextEncoder().encode("not json");
    expect(decodeJoy(bad)).toBeNull();
  });

  it("decodeJoy returns null when type is not 'joy'", () => {
    const movement = {
      type: "movement",
      ...BASE,
      axes: { forward: 0, lateral: 0, yaw: 0 },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(movement));
    expect(decodeJoy(bytes)).toBeNull();
  });
});

// ── encodeCommand / decodeCommand polymorphic path ──────────────────────────

describe("encodeCommand / decodeCommand with JoyCommand", () => {
  it("round-trips JoyCommand via generic encode/decode", () => {
    const cmd = JoyCommand.parse(ACTIVE_JOY);
    const bytes = encodeCommand(cmd);
    const decoded = decodeCommand(bytes);

    expect(decoded).not.toBeNull();
    expect(decoded?.type).toBe("joy");
    // Narrow type to access joy payload
    if (decoded?.type === "joy") {
      expect(decoded.joy.axes[3]).toBeCloseTo(0.5);
    }
  });

  it("decodeCommand returns null for garbage input", () => {
    const bytes = new TextEncoder().encode("{bad json");
    expect(decodeCommand(bytes)).toBeNull();
  });
});

// ── Edge cases (safety-relevant) ─────────────────────────────────────────────

describe("JoyCommand edge cases (safety-relevant)", () => {
  it("allows exactly -1 and +1 axis values (boundary)", () => {
    const boundary = {
      ...MINIMAL_JOY,
      joy: {
        ...MINIMAL_JOY.joy,
        axes: [-1, 1, -1, 1, -1, 1, -1, 1],
      },
    };
    expect(JoyCommand.safeParse(boundary).success).toBe(true);
  });

  it("rejects axis value of -1.001 (just outside boundary)", () => {
    const bad = {
      ...MINIMAL_JOY,
      joy: { ...MINIMAL_JOY.joy, axes: [-1.001, 0, 0, 0, 0, 0, 0, 0] },
    };
    expect(JoyCommand.safeParse(bad).success).toBe(false);
  });

  it("rejects axis value of 1.001 (just outside boundary)", () => {
    const bad = {
      ...MINIMAL_JOY,
      joy: { ...MINIMAL_JOY.joy, axes: [1.001, 0, 0, 0, 0, 0, 0, 0] },
    };
    expect(JoyCommand.safeParse(bad).success).toBe(false);
  });

  it("rejects missing vehicleId", () => {
    const { vehicleId: _v, ...noVehicle } = MINIMAL_JOY;
    expect(JoyCommand.safeParse(noVehicle).success).toBe(false);
  });

  it("rejects non-integer seq", () => {
    const bad = { ...MINIMAL_JOY, seq: 1.5 };
    expect(JoyCommand.safeParse(bad).success).toBe(false);
  });

  it("preserves seq monotonicity across two frames (encode/decode)", () => {
    const frame1 = JoyCommand.parse({ ...MINIMAL_JOY, seq: 1 });
    const frame2 = JoyCommand.parse({ ...MINIMAL_JOY, seq: 2 });
    const d1 = decodeJoy(encodeJoy(frame1));
    const d2 = decodeJoy(encodeJoy(frame2));
    expect(d1?.seq).toBe(1);
    expect(d2?.seq).toBe(2);
    expect((d2?.seq ?? 0) > (d1?.seq ?? 0)).toBe(true);
  });
});
