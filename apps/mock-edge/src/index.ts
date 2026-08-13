/**
 * Mock Edge Agent receiver.
 *
 * Joins a Livekit room as a participant, subscribes to the operator's
 * DataChannel, validates incoming control commands, enforces the heartbeat /
 * safe_mode safety contract (spec: openspec/control/heartbeat.md,
 * openspec/safety/safe-mode.md), and reports significant events back to the
 * backend audit endpoint.
 *
 * Designed to be replaced by the real Edge Agent on AGX Orin (slice 6).
 * The safety logic here MUST stay consistent with the real Edge Agent.
 *
 * Run: pnpm --filter @rvep/mock-edge start
 *
 * Env:
 *   LIVEKIT_URL              ws://192.168.68.68:7880
 *   LIVEKIT_API_KEY          devkey
 *   LIVEKIT_API_SECRET       devsecret
 *   VEHICLE_ID               vehicle-001
 *   BACKEND_URL              http://192.168.68.68:3010 (or http://localhost:3010)
 *   INTERNAL_TOKEN           shared secret with backend (audit endpoint auth)
 *
 * Video Publisher (optional — requires Go publisher binary on Orin):
 *   VIDEO_PUBLISHER_ENABLED          false (set to "true" to activate)
 *   VIDEO_PUBLISHER_CAMERA_PROFILES  comma-separated YAML paths
 *                                    e.g. /etc/rvep/cameras/front.yaml,/etc/rvep/cameras/rear.yaml
 */

import { Room, RoomEvent, RemoteParticipant, DataPacket_Kind } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import {
  decodeCommand,
  encodeSafetyEvent,
  type ControlCommand,
  type SafetyEvent,
  type SafetyEventName,
  type VehicleStatus,
} from "@rvep/shared";
import * as path from "path";
import { randomUUID } from "crypto";
import { GoPublisherManager } from "./go-publisher-manager.js";
import { MockTelemetryPublisher } from "./telemetry-publisher.js";
import { MetadataWriter } from "./metadata-writer.js";

const LIVEKIT_URL = process.env.LIVEKIT_URL ?? "ws://192.168.68.68:7880";
const API_KEY = process.env.LIVEKIT_API_KEY ?? "devkey";
const API_SECRET = process.env.LIVEKIT_API_SECRET ?? "devsecret";
const VEHICLE_ID = process.env.VEHICLE_ID ?? "vehicle-001";
const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3010";
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? "internal-dev-token";

const ROOM_NAME = `ugv-${VEHICLE_ID}`;
const IDENTITY = `edge-${VEHICLE_ID}`;
const HEARTBEAT_TIMEOUT_MS = 3000;
const HEARTBEAT_CHECK_INTERVAL_MS = 500;

// ── Video publisher env ───────────────────────────────────────────────────────
const VIDEO_PUBLISHER_ENABLED =
  (process.env["VIDEO_PUBLISHER_ENABLED"] ?? "false").toLowerCase() === "true";
const VIDEO_PUBLISHER_CAMERA_PROFILES =
  (process.env["VIDEO_PUBLISHER_CAMERA_PROFILES"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// ── Dataset writer ────────────────────────────────────────────────────────────
// Dev default: $HOME/.rvep/datasets (survives reboot, no special perms needed)
// Production (Orin/Thor): override via DATASET_ROOT=/var/lib/rvep/datasets in
// the systemd unit (FHS-compliant; dedicated SSD mount point).
const DATASET_ROOT =
  process.env["DATASET_ROOT"] ??
  `${process.env["HOME"] ?? "/tmp"}/.rvep/datasets`;
const DATASET_ENABLED =
  (process.env["DATASET_ENABLED"] ?? "true").toLowerCase() !== "false";

interface SafetyState {
  safeMode: boolean;
  reason: string;
  lastHeartbeatAt: number;       // monotonic ms
  lastAcceptedSeq: number;
  lastAcceptedEpoch: number;
  sessionId: string;             // assigned at boot
  safetySeq: number;             // monotonic counter for SafetyEvent broadcasts
}

const state: SafetyState = {
  safeMode: true,                // boot default: safe
  reason: "boot_default",
  lastHeartbeatAt: 0,
  lastAcceptedSeq: 0,
  lastAcceptedEpoch: 0,
  sessionId: randomUUID(),
  safetySeq: 0,
};

// Room handle is assigned once room.connect() succeeds; safety event publish
// is a no-op before that (boot_default safe_mode is implicit until UI joins).
let activeRoom: Room | null = null;

async function publishSafetyEvent(
  event: SafetyEventName,
  reason?: string,
  message?: string,
) {
  if (!activeRoom) return;
  state.safetySeq += 1;
  const evt: SafetyEvent = {
    kind: "safety_event",
    v: 1,
    ts: Date.now(),
    vehicleId: VEHICLE_ID,
    sessionId: state.sessionId,
    seq: state.safetySeq,
    event,
    reason,
    message,
  };
  try {
    await activeRoom.localParticipant?.publishData(encodeSafetyEvent(evt), {
      reliable: true,
      topic: "safety",
    });
  } catch (err) {
    console.warn("[safety] publish failed:", (err as Error).message);
  }
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function reportEvent(eventName: string, payload: unknown) {
  try {
    const res = await fetch(`${BACKEND_URL}/api/v1/internal/control-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-token": INTERNAL_TOKEN,
      },
      body: JSON.stringify({
        vehicleId: VEHICLE_ID,
        eventName,
        payload,
        ts: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      console.warn("[audit] backend rejected", res.status, await res.text());
    }
  } catch (err) {
    console.warn("[audit] failed to reach backend:", (err as Error).message);
  }
}

function enterSafeMode(reason: string) {
  if (state.safeMode && state.reason === reason) return;
  state.safeMode = true;
  state.reason = reason;
  console.warn(`[safe_mode] entered (reason=${reason})`);
  void reportEvent("safe_mode_entered", { reason });
  // Broadcast to operator UI so it can lock joystick + show recovery modal.
  void publishSafetyEvent("safe_mode_entered", reason);
  // emergency_stop side-effect: zero velocity (mock — just log).
  console.warn("[mock_vehicle] publish 0 velocity × 10Hz × 2s");
}

function leaveSafeMode() {
  if (!state.safeMode) return;
  state.safeMode = false;
  console.log("[safe_mode] left");
  void reportEvent("manual_recovery_confirmed", {});
  void publishSafetyEvent("safe_mode_left", "operator_resume");
}

function handleCommand(cmd: ControlCommand) {
  // 1. epoch / seq dedupe
  if (cmd.connectionEpoch < state.lastAcceptedEpoch) {
    console.warn(`[stale] epoch ${cmd.connectionEpoch} < ${state.lastAcceptedEpoch}, ignored`);
    return;
  }
  if (cmd.connectionEpoch > state.lastAcceptedEpoch) {
    state.lastAcceptedEpoch = cmd.connectionEpoch;
    state.lastAcceptedSeq = 0; // reset per epoch
  }
  if (cmd.seq <= state.lastAcceptedSeq) {
    return; // duplicate / stale
  }
  state.lastAcceptedSeq = cmd.seq;

  switch (cmd.type) {
    case "heartbeat":
      state.lastHeartbeatAt = nowMs();
      // first valid heartbeat after boot doesn't auto-leave safe_mode;
      // operator must send resume_control.
      break;

    case "emergency_stop":
      console.log(`[cmd] emergency_stop seq=${cmd.seq}`);
      enterSafeMode("emergency_stop");
      void reportEvent("emergency_stop", { seq: cmd.seq, ts: cmd.timestamp });
      break;

    case "resume_control":
      if (cmd.acknowledgement !== "operator_confirmed") {
        console.warn("[resume] denied: missing acknowledgement");
        void reportEvent("resume_denied", { reason: "missing_acknowledgement" });
        return;
      }
      if (nowMs() - state.lastHeartbeatAt > 1000) {
        console.warn("[resume] denied: heartbeat stale");
        void reportEvent("resume_denied", { reason: "heartbeat_stale" });
        return;
      }
      console.log("[cmd] resume_control accepted");
      // Always re-broadcast safe_mode_left so a UI that joined AFTER the original
      // leaveSafeMode() can also pick up the active state (idempotent ack).
      if (state.safeMode) {
        leaveSafeMode();
      } else {
        void publishSafetyEvent("safe_mode_left", "already_active");
      }
      break;

    case "movement":
      if (state.safeMode) {
        console.warn(`[blocked] movement while safe_mode (reason=${state.reason})`);
        void reportEvent("safety_blocked_movement", { axes: cmd.axes });
        return;
      }
      // mock vehicle: just log (real adapter would call ROS2 /cmd_vel etc.)
      console.log(`[cmd] movement fwd=${cmd.axes.forward.toFixed(2)} yaw=${cmd.axes.yaw.toFixed(2)}`);
      break;

    case "joy": {
      // c12 — operator gamepad raw axes + buttons (per sensor_msgs/Joy).
      // In r2-bridge: republish to /joy topic; teleop_twist_joy does mapping.
      // In mock-edge: derive forward/lateral/yaw from standard layout for demo log.
      if (state.safeMode) {
        return;
      }
      const ax = cmd.joy.axes;
      // Web Gamepad standard: axes[0]=LX (lateral), axes[1]=LY (forward, up=-1),
      // axes[2]=RX (yaw)
      const forward = -(ax[1] ?? 0);
      const lateral = ax[0] ?? 0;
      const yaw = -(ax[2] ?? 0);
      // Throttle log so it doesn't spam at 20 Hz
      if ((state.lastAcceptedSeq ?? 0) % 10 === 1) {
        console.log(
          `[cmd] joy fwd=${forward.toFixed(2)} lat=${lateral.toFixed(2)} yaw=${yaw.toFixed(2)} btns=[${cmd.joy.buttons.join("")}]`,
        );
      }
      break;
    }

    case "action":
      if (state.safeMode) {
        console.warn(`[blocked] action ${cmd.action} while safe_mode`);
        return;
      }
      console.log(`[cmd] action ${cmd.action}`);
      break;

    case "config":
      console.log(`[cmd] config ${cmd.key}=${String(cmd.value)}`);
      break;
  }
}

function startHeartbeatWatcher() {
  setInterval(() => {
    if (state.lastHeartbeatAt === 0) return; // no heartbeat seen yet
    if (state.safeMode) return;              // already safe
    const age = nowMs() - state.lastHeartbeatAt;
    if (age > HEARTBEAT_TIMEOUT_MS) {
      enterSafeMode("heartbeat_timeout");
    }
  }, HEARTBEAT_CHECK_INTERVAL_MS);
}

async function main() {
  console.log(`[mock-edge] joining room=${ROOM_NAME} identity=${IDENTITY}`);

  // ── Video publisher managers (optional) ─────────────────────────────────────
  // Instantiated before room.connect so socket servers are ready when the
  // Go publisher binary tries to connect.  stop() is called before
  // room.disconnect() in the shutdown handler so that ghost tracks are removed
  // from the SFU before the edge participant leaves.
  const publisherManagers: GoPublisherManager[] = [];

  if (VIDEO_PUBLISHER_ENABLED) {
    if (VIDEO_PUBLISHER_CAMERA_PROFILES.length === 0) {
      console.warn(
        "[mock-edge] VIDEO_PUBLISHER_ENABLED=true but VIDEO_PUBLISHER_CAMERA_PROFILES is empty — no publishers started",
      );
    } else {
      for (const profilePath of VIDEO_PUBLISHER_CAMERA_PROFILES) {
        // Derive cameraId from the YAML filename (e.g. front.yaml → front)
        const cameraId = path.basename(profilePath, path.extname(profilePath));
        const mgr = new GoPublisherManager({
          vehicleId: VEHICLE_ID,
          camera: {
            cameraId,
            cameraProfilePath: profilePath,
            videoProfileId: cameraId,
          },
          livekitUrl: LIVEKIT_URL,
          apiKey: API_KEY,
          apiSecret: API_SECRET,
          roomName: ROOM_NAME,
        });

        mgr.on("stateChange", (s) =>
          console.log(`[publisher-mgr:${cameraId}] state → ${s}`),
        );
        mgr.on("heartbeat", (hb) =>
          console.log(
            `[publisher-mgr:${cameraId}] heartbeat state=${hb.publisherState} fps=${hb.metrics.fps}`,
          ),
        );
        mgr.on("error", (err) =>
          console.warn(`[publisher-mgr:${cameraId}] error: ${err.message}`),
        );
        mgr.on("crashed", (code, signal) =>
          void reportEvent("publisher_crashed", { cameraId, code, signal }),
        );
        mgr.on("restarted", (attempt) =>
          void reportEvent("publisher_restarted", { cameraId, attempt }),
        );
        mgr.on("failed", () =>
          void reportEvent("publisher_failed", { cameraId }),
        );

        await mgr.start();
        publisherManagers.push(mgr);
        console.log(`[mock-edge] video publisher started for camera=${cameraId}`);
      }
    }
  }

  const at = new AccessToken(API_KEY, API_SECRET, { identity: IDENTITY });
  at.addGrant({ roomJoin: true, room: ROOM_NAME, canPublish: true, canSubscribe: true, canPublishData: true });
  const token = await at.toJwt();

  const room = new Room();

  room.on(RoomEvent.Connected, () => {
    console.log(`[mock-edge] connected to ${ROOM_NAME}`);
    activeRoom = room;
    void reportEvent("edge_online", { identity: IDENTITY });
    // Tell any already-connected operator UI we're live and currently safe_mode
    // (boot default).  The UI will show the recovery modal so the operator
    // explicitly confirms control before joystick becomes active.
    void publishSafetyEvent("edge_online");
    if (state.safeMode) {
      void publishSafetyEvent("safe_mode_entered", state.reason);
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    console.warn("[mock-edge] disconnected from room");
    activeRoom = null;
    enterSafeMode("room_disconnected");
  });

  room.on(RoomEvent.DataReceived, (payload: Uint8Array, _participant?: RemoteParticipant, _kind?: DataPacket_Kind) => {
    const cmd = decodeCommand(payload);
    if (!cmd) {
      console.warn("[decode] invalid payload");
      return;
    }
    if (cmd.vehicleId !== VEHICLE_ID) {
      console.warn(`[scope] command for ${cmd.vehicleId}, expected ${VEHICLE_ID}`);
      return;
    }
    handleCommand(cmd);
  });

  startHeartbeatWatcher();

  // autoSubscribe: false — mock-edge is receiver-side simulator, doesn't need video.
  // Avoids NVDEC HW decoder crash (error 100) when LiveKit native tries to decode video.
  await room.connect(LIVEKIT_URL, token, { autoSubscribe: false, dynacast: false });

  // @livekit/rtc-node v0.13 does NOT fire RoomEvent.Connected after connect()
  // resolves — set activeRoom + emit "edge_online" + initial safe_mode broadcast
  // directly here so the operator UI receives the safety event immediately.
  activeRoom = room;
  console.log(`[mock-edge] connected to ${ROOM_NAME}`);
  void reportEvent("edge_online", { identity: IDENTITY });
  void publishSafetyEvent("edge_online");
  if (state.safeMode) {
    void publishSafetyEvent("safe_mode_entered", state.reason);
  }

  // ── Telemetry publisher ─────────────────────────────────────────────────────
  // Reuses the DataChannel (reliable) so operator UI receives 5 Hz status.
  // sessionId is from state.sessionId (assigned at boot, shared with SafetyEvent stream).
  const telemetry = new MockTelemetryPublisher({
    vehicleId: VEHICLE_ID,
    sessionId: state.sessionId,
    room,
    rateHz: 5,
    getVehicleStatus: (): VehicleStatus => ({
      mode: state.safeMode ? "safe" : "manual",
      controlLeaseHolder: state.safeMode ? undefined : "operator",
    }),
    auditSink: {
      backendUrl: BACKEND_URL,
      internalToken: INTERNAL_TOKEN,
      everyN: 5, // 5 Hz → 1 Hz audit (every 5th frame)
    },
  });
  telemetry.start();
  console.log(`[mock-edge] telemetry + safety events on sessionId=${state.sessionId}`);

  // ── Dataset metadata writer (Phase 1) ───────────────────────────────────────
  const dataset = DATASET_ENABLED
    ? new MetadataWriter({
        rootDir: DATASET_ROOT,
        vehicleId: VEHICLE_ID,
        sessionId: state.sessionId,
        backendUrl: BACKEND_URL,
        internalToken: INTERNAL_TOKEN,
      })
    : null;

  if (dataset) {
    dataset.open();
    // Sample once per second (matches the 1 Hz backend audit cadence).
    const datasetTimer = setInterval(() => {
      dataset.append({
        operatorId: state.safeMode ? undefined : "operator",
        mode: state.safeMode ? "safe_mode" : "operator_control",
        // Phase 1: telemetry is also captured by the MockTelemetryPublisher and
        // audited to TelemetryFrame separately.  The metadata.jsonl here is
        // a session-level transcript suitable for future replay.
      });
    }, 1000);
    // Stop timer + finalize on SIGINT/SIGTERM (handled in shutdown below).
    process.once("beforeExit", () => clearInterval(datasetTimer));
    (state as unknown as { datasetTimer?: NodeJS.Timeout }).datasetTimer = datasetTimer;
  }

  // graceful shutdown
  // Order: stop telemetry → stop video publishers → disconnect room.
  // Telemetry first so no stale messages hit the SFU during teardown.
  const shutdown = async () => {
    console.log("[mock-edge] shutting down");

    // Tell any connected UI we're going down — gives operator a chance to see
    // "edge_disconnecting" before the room actually drops.
    await publishSafetyEvent("edge_disconnecting", "shutdown");

    // Stop telemetry and finalize dataset BEFORE room.disconnect so backend
    // still resolves DNS / TCP cleanly when we POST the manifest.
    const dsTimer = (state as unknown as { datasetTimer?: NodeJS.Timeout }).datasetTimer;
    if (dsTimer) clearInterval(dsTimer);
    if (dataset) await dataset.finalize();

    await telemetry.stop();

    if (publisherManagers.length > 0) {
      console.log("[mock-edge] stopping video publishers…");
      await Promise.all(publisherManagers.map((m) => m.stop()));
      console.log("[mock-edge] video publishers stopped");
    }

    await room.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[mock-edge] fatal", err);
  process.exit(1);
});
