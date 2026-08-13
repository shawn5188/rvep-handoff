"use client";

import { DataPacket_Kind, Room } from "livekit-client";
import {
  encodeCommand,
  type ControlCommand,
  type MovementCommand,
  type EmergencyStopCommand,
  type HeartbeatMessage,
  type ResumeControlCommand,
  type JoyCommand,
} from "@rvep/shared";

/**
 * Operator-side control channel: wraps a Livekit Room's DataChannel
 * with the universal control command schema + sequence numbering +
 * per-second heartbeat lifecycle.
 *
 * Source spec: openspec/control/universal-control-command.md
 *              openspec/control/heartbeat.md
 *              openspec/control/sequence-numbering.md
 */
/** Live stats for the Live Control Data panel (C6 enhancement, 2026-05-22). */
export interface ControlStats {
  /** Operator-frame longitudinal (−1..1) — maps to cmd_vel.linear.x on ROS2 bridge. */
  forward: number;
  /** Operator-frame lateral (−1..1) — maps to cmd_vel.linear.y for holonomic, ignored on diff-drive. */
  lateral: number;
  /** Operator-frame yaw rate (−1..1) — maps to cmd_vel.angular.z. */
  yaw: number;
  /** ms since last movement command sent (Number.POSITIVE_INFINITY if none yet) */
  lastCmdAgoMs: number;
  /** commands sent in the last 1 second (rough rate) */
  rateHz: number;
  totalCommands: number;
  lastEmergencyStopAgoMs: number;
}

export class ControlChannel {
  private seq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ── Stats（C6 視覺化用） ────────────────────────────────────────────────
  private lastMovementTs = 0;
  private lastMovement = { forward: 0, lateral: 0, yaw: 0 };
  private lastEmergencyStopTs = 0;
  private totalCommands = 0;
  /** sliding window of recent movement timestamps (for Hz calc) */
  private recentTs: number[] = [];

  constructor(
    private room: Room,
    private vehicleId: string,
    private sessionId: string,
    private connectionEpoch: number,
  ) {}

  /** Snapshot current stats for visualization panel. */
  getStats(): ControlStats {
    const now = Date.now();
    const oneSecAgo = now - 1000;
    // prune old timestamps
    this.recentTs = this.recentTs.filter((t) => t > oneSecAgo);
    return {
      forward: this.lastMovement.forward,
      lateral: this.lastMovement.lateral,
      yaw: this.lastMovement.yaw,
      lastCmdAgoMs:
        this.lastMovementTs === 0
          ? Number.POSITIVE_INFINITY
          : now - this.lastMovementTs,
      rateHz: this.recentTs.length,
      totalCommands: this.totalCommands,
      lastEmergencyStopAgoMs:
        this.lastEmergencyStopTs === 0
          ? Number.POSITIVE_INFINITY
          : now - this.lastEmergencyStopTs,
    };
  }

  /** Begin sending 1-Hz heartbeat. Safe to call multiple times (idempotent). */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    // send first heartbeat immediately so receiver can leave default safe_mode
    void this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, 1000);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  sendMovement(axes: MovementCommand["axes"]): Promise<void> {
    const cmd: MovementCommand = {
      type: "movement",
      ...this.envelope(),
      axes,
    };
    // update stats before publish
    const now = Date.now();
    this.lastMovement = {
      forward: axes.forward,
      lateral: axes.lateral,
      yaw: axes.yaw,
    };
    this.lastMovementTs = now;
    this.recentTs.push(now);
    this.totalCommands += 1;
    return this.publish(cmd, /* reliable */ false);
  }

  sendEmergencyStop(): Promise<void> {
    const cmd: EmergencyStopCommand = {
      type: "emergency_stop",
      ...this.envelope(),
    };
    this.lastEmergencyStopTs = Date.now();
    this.totalCommands += 1;
    // emergency stop must arrive — use reliable channel.
    return this.publish(cmd, /* reliable */ true);
  }

  /**
   * Fire-and-forget emergency stop for `visibilitychange → hidden` and
   * `pagehide` paths. Mobile browsers may freeze our JS context immediately
   * after these events; awaiting the publish Promise would let the freeze
   * win the race. Calling `publishData` synchronously hands the payload to
   * the UA's WebRTC stack before the JS task ends, after which the OS-level
   * flush proceeds independently of the JS thread.
   */
  sendEmergencyStopSync(): void {
    const cmd: EmergencyStopCommand = {
      type: "emergency_stop",
      ...this.envelope(),
    };
    const payload = encodeCommand(cmd);
    try {
      void this.room.localParticipant.publishData(payload, { reliable: true });
    } catch {
      // network may already be torn down — best effort only.
    }
  }

  sendResume(): Promise<void> {
    const cmd: ResumeControlCommand = {
      type: "resume_control",
      ...this.envelope(),
      acknowledgement: "operator_confirmed",
    };
    return this.publish(cmd, /* reliable */ true);
  }

  /**
   * Send raw gamepad state as JoyCommand to r2-bridge.
   * The bridge republishes it as sensor_msgs/Joy → teleop_twist_joy → /cmd_vel.
   *
   * joy should already have deadzone applied by useGamepad hook.
   * Uses unreliable channel per 20 Hz timing requirement (same as sendMovement).
   *
   * Spec: openspec/features/contract-c1-c8/c12-joystick-support.md §Schema
   */
  sendJoy(joy: JoyCommand["joy"]): Promise<void> {
    const cmd: JoyCommand = {
      type: "joy",
      ...this.envelope(),
      joy,
    };
    return this.publish(cmd, /* reliable */ false);
  }

  private sendHeartbeat(): Promise<void> {
    const msg: HeartbeatMessage = {
      type: "heartbeat",
      ...this.envelope(),
    };
    return this.publish(msg, /* reliable */ false);
  }

  private envelope() {
    this.seq += 1;
    return {
      vehicleId: this.vehicleId,
      sessionId: this.sessionId,
      connectionEpoch: this.connectionEpoch,
      seq: this.seq,
      timestamp: new Date().toISOString(),
    };
  }

  private async publish(cmd: ControlCommand, reliable: boolean): Promise<void> {
    const payload = encodeCommand(cmd);
    await this.room.localParticipant.publishData(payload, {
      reliable,
      // omit destinationIdentities → broadcast to room
    });
  }
}

export { DataPacket_Kind };
