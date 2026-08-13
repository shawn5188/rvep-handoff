/**
 * Universal Control Command schemas — shared between web client, backend, and
 * Edge Agent. Source spec: openspec/control/universal-control-command.md
 *
 * All messages share base fields. The discriminator is `type`.
 */
import { z } from "zod";

const baseFields = {
  vehicleId: z.string().min(1),
  sessionId: z.string().min(1),
  connectionEpoch: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  timestamp: z.string().datetime(), // ISO 8601 UTC, millisecond precision
};

/**
 * Source health states, borrowed from rv2_control_signal_transport CSM design
 * (ADR-013). Carried in JoyCommand so the bridge can surface joystick link
 * quality without a separate telemetry path.
 */
export const SourceHealthEnum = z.enum([
  "ACTIVE",
  "LOW_FREQ",
  "TIMEOUT",
  "DISCONNECTED",
  "UNKNOWN",
]);

export const MovementCommand = z.object({
  type: z.literal("movement"),
  ...baseFields,
  axes: z.object({
    forward: z.number().min(-1).max(1),
    lateral: z.number().min(-1).max(1),
    yaw: z.number().min(-1).max(1),
  }),
});

export const EmergencyStopCommand = z.object({
  type: z.literal("emergency_stop"),
  ...baseFields,
});

export const HeartbeatMessage = z.object({
  type: z.literal("heartbeat"),
  ...baseFields,
});

export const ResumeControlCommand = z.object({
  type: z.literal("resume_control"),
  ...baseFields,
  acknowledgement: z.literal("operator_confirmed"),
});

export const ActionCommand = z.object({
  type: z.literal("action"),
  ...baseFields,
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const ConfigCommand = z.object({
  type: z.literal("config"),
  ...baseFields,
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

/**
 * JoyCommand — raw gamepad/joystick state forwarded to r2-bridge, which
 * republishes it as sensor_msgs/Joy so teleop_twist_joy can map to /cmd_vel.
 *
 * axes / buttons mirror sensor_msgs/Joy layout exactly:
 *   axes[0]=LX  axes[1]=LY  axes[2]=LT  axes[3]=RX  axes[4]=RY  axes[5]=RT
 *   axes[6]=DPad-X  axes[7]=DPad-Y
 *   buttons[4]=LB  buttons[5]=RB  (enable_button / enable_turbo_button)
 *
 * Spec: openspec/features/contract-c1-c8/c12-joystick-support.md
 *       openspec/safety/joystick-gates.md
 *       ADR-013
 */
export const JoyCommand = z.object({
  type: z.literal("joy"),
  ...baseFields,
  joy: z.object({
    /** Raw axis values in [-1, 1] — deadzone already applied by web hook. */
    axes: z.array(z.number().min(-1).max(1)),
    /** Button states 0 or 1. */
    buttons: z.array(z.union([z.literal(0), z.literal(1)])),
    /** Web Gamepad API id — e.g. "Xbox 360 Controller (XInput STANDARD GAMEPAD)". */
    controllerId: z.string(),
  }),
  /**
   * Source health from web hook perspective (ACTIVE = 20 Hz frames arriving).
   * Optional so older senders remain compatible.
   */
  sourceHealth: SourceHealthEnum.optional(),
});

export const ControlCommand = z.discriminatedUnion("type", [
  MovementCommand,
  EmergencyStopCommand,
  HeartbeatMessage,
  ResumeControlCommand,
  ActionCommand,
  ConfigCommand,
  JoyCommand,
]);

export type SourceHealth = z.infer<typeof SourceHealthEnum>;
export type MovementCommand = z.infer<typeof MovementCommand>;
export type EmergencyStopCommand = z.infer<typeof EmergencyStopCommand>;
export type HeartbeatMessage = z.infer<typeof HeartbeatMessage>;
export type ResumeControlCommand = z.infer<typeof ResumeControlCommand>;
export type ActionCommand = z.infer<typeof ActionCommand>;
export type ConfigCommand = z.infer<typeof ConfigCommand>;
export type JoyCommand = z.infer<typeof JoyCommand>;
export type ControlCommand = z.infer<typeof ControlCommand>;

/**
 * Encode command to UTF-8 bytes for DataChannel publishData().
 */
export function encodeCommand(cmd: ControlCommand): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(cmd));
}

/**
 * Decode and validate a DataChannel payload. Returns null on parse / validation error.
 */
export function decodeCommand(bytes: Uint8Array): ControlCommand | null {
  try {
    const text = new TextDecoder().decode(bytes);
    const json: unknown = JSON.parse(text);
    const parsed = ControlCommand.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Encode a JoyCommand directly (convenience wrapper — avoids casting at call site).
 * Bridge receives raw bytes; same wire format as encodeCommand.
 */
export function encodeJoy(cmd: JoyCommand): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(cmd));
}

/**
 * Decode bytes that are expected to contain a JoyCommand.
 * Returns null if parse fails or the discriminator is not "joy".
 */
export function decodeJoy(bytes: Uint8Array): JoyCommand | null {
  try {
    const text = new TextDecoder().decode(bytes);
    const json: unknown = JSON.parse(text);
    const parsed = JoyCommand.safeParse(json);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
