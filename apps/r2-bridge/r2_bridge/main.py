"""r2-bridge — LiveKit DataChannel → ROS2 /rvep/cmd_vel bridge.

Single-process Python (asyncio + rclpy in thread). Subscribes to operator's
DataChannel via LiveKit, decodes RVEP universal control schema, publishes
geometry_msgs/Twist on /rvep/cmd_vel + /rvep/emergency_stop. twist_mux is
expected to be running separately and merge these into the base /cmd_vel.

Demo subset of C9 (S21.2 + S21.3 + S21.4 collapsed). Post-demo refactor to
Node + Python dual process per ADR-011 D5 / r2-rvep-bridge.md.

Env vars:
  LIVEKIT_URL          ws:// host:port (default: ws://192.168.68.68:7880)
  LIVEKIT_TOKEN        JWT for room=$VEHICLE_ID identity (REQUIRED)
  VEHICLE_ID           room name (default: r2-001)
  HEARTBEAT_TIMEOUT_S  watchdog trip (default: 3.0)
  MAX_LINEAR_MS        normalised axis → m/s scale (default: 0.3)
  MAX_ANGULAR_RADS     normalised axis → rad/s scale (default: 0.8)
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import signal
import sys
import threading
import time
import uuid
from typing import Any

import rclpy
from livekit import rtc
from rclpy.node import Node
from nav_msgs.msg import Odometry
from sensor_msgs.msg import Imu, Joy
from std_msgs.msg import Float32

from .vehicle_adapter import VehicleAdapter, WheeltecAMRAdapter


LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "ws://192.168.68.68:7880")
LIVEKIT_TOKEN = os.environ.get("LIVEKIT_TOKEN", "")
VEHICLE_ID = os.environ.get("VEHICLE_ID", "r2-001")
HEARTBEAT_TIMEOUT_S = float(os.environ.get("HEARTBEAT_TIMEOUT_S", "3.0"))
MAX_LINEAR_MS = float(os.environ.get("MAX_LINEAR_MS", "0.3"))
MAX_ANGULAR_RADS = float(os.environ.get("MAX_ANGULAR_RADS", "0.8"))

# Publish mode — controls where Twist commands land:
#   "mirror" (default, current demo path): publish to BOTH /cmd_vel (motor) AND
#       /rvep/cmd_vel (observability + future CSM source). Twist_mux 4.3.0 has
#       QoS drop bug so direct /cmd_vel is the reliable path.
#   "csm" : publish ONLY to /rvep/cmd_vel — assume CSM (rv2_control_signal_
#       transport) is running and subscribes to /rvep/cmd_vel as a Source with
#       priority=80, then arbitrates → /cmd_vel. Used after CSM Phase 2 cutover.
# Spec: openspec/control/rvep-csm-icd.md + project_rv2_csm_integration_plan memory
PUBLISH_MODE = os.environ.get("BRIDGE_PUBLISH_MODE", "mirror")
if PUBLISH_MODE not in ("mirror", "csm"):
    print(f"WARN: unknown BRIDGE_PUBLISH_MODE={PUBLISH_MODE!r}, falling back to 'mirror'", file=sys.stderr)
    PUBLISH_MODE = "mirror"

# Telemetry publish rate to LiveKit DataChannel (Hz)
TELEMETRY_HZ = float(os.environ.get("TELEMETRY_HZ", "5"))

# Battery voltage → percentage estimate. Defaults assume Wheeltec 12V Pb/Li-ion.
# Tune per battery chemistry; out-of-range values clamp to 0/100.
BATTERY_FULL_V = float(os.environ.get("BATTERY_FULL_V", "12.6"))
BATTERY_EMPTY_V = float(os.environ.get("BATTERY_EMPTY_V", "10.5"))


def _quat_to_yaw(qx: float, qy: float, qz: float, qw: float) -> float:
    """Quaternion (xyzw) → yaw angle (rad)."""
    siny_cosp = 2.0 * (qw * qz + qx * qy)
    cosy_cosp = 1.0 - 2.0 * (qy * qy + qz * qz)
    return math.atan2(siny_cosp, cosy_cosp)


def _voltage_to_pct(v: float) -> float:
    """Linear voltage → battery % estimate, clamped 0-100."""
    pct = (v - BATTERY_EMPTY_V) / (BATTERY_FULL_V - BATTERY_EMPTY_V) * 100.0
    return max(0.0, min(100.0, pct))

log = logging.getLogger("r2-bridge")


class RosPublisher(Node):
    """rclpy node that owns the two /rvep/* publishers."""

    def __init__(self, adapter: VehicleAdapter) -> None:
        super().__init__("r2_rvep_bridge")
        # Adapter owns vehicle-specific motor publishers (R2 = WheeltecAMRAdapter).
        # New vehicles (Unitree B2-W, manipulators) plug a different adapter
        # without touching this class.
        self.adapter = adapter
        self.adapter.init_publishers(self)

        # ── Joy publisher (C12 — Xbox 360 / gamepad support) ─────────────────
        # Publishes sensor_msgs/Joy so teleop_twist_joy can map axes → /cmd_vel.
        # QoS depth 10 RELIABLE per joystick-gates.md §Heartbeat Watchdog.
        from rclpy.qos import QoSProfile, ReliabilityPolicy
        joy_qos = QoSProfile(depth=10, reliability=ReliabilityPolicy.RELIABLE)
        self._joy_pub = self.create_publisher(Joy, "/joy", joy_qos)

        # ── Telemetry subscribers — cache latest sample per source ────────
        # Latest /odom_combined (Wheeltec emits this — covers velocity + pose)
        self._latest_odom: dict[str, Any] | None = None
        # Latest /PowerVoltage (Wheeltec emits raw float voltage)
        self._latest_voltage: float | None = None
        # Latest /mobile_base/sensors/imu_data (optional)
        self._latest_imu: dict[str, Any] | None = None
        # Track first-frame capabilities advertisement
        self._caps_published = False
        self._last_odom_ts = 0.0
        self._last_voltage_ts = 0.0
        self._last_imu_ts = 0.0

        # Wheeltec topic names (verified 2026-05-23 on deployed Robot_start_node):
        #   /odom                   nav_msgs/Odometry (velocity + pose)
        #   /robot/PowerValtage     std_msgs/Float32  (typo by Wheeltec, intentional preserve)
        #   /mobile_base/sensors/imu_data  sensor_msgs/Imu
        # Source backup wheeltec_robot.cpp used different names (odom_combined,
        # PowerVoltage) — that's an older Wheeltec branch. Use deployed names.
        self.create_subscription(Odometry, "/odom", self._on_odom, 10)
        self.create_subscription(Float32, "/robot/PowerValtage", self._on_voltage, 10)
        self.create_subscription(Imu, "/mobile_base/sensors/imu_data", self._on_imu, 10)

        self.get_logger().info(
            f"r2-bridge ROS2 node ready (adapter={self.adapter.name})"
        )

    # ── Telemetry callbacks ────────────────────────────────────────────────
    def _on_odom(self, msg: Odometry) -> None:
        now = time.time()
        q = msg.pose.pose.orientation
        self._latest_odom = {
            "velocity": {
                "linearX": float(msg.twist.twist.linear.x),
                "linearY": float(msg.twist.twist.linear.y),
                "angularZ": float(msg.twist.twist.angular.z),
            },
            "odom": {
                "x": float(msg.pose.pose.position.x),
                "y": float(msg.pose.pose.position.y),
                "yaw": _quat_to_yaw(q.x, q.y, q.z, q.w),
                "frame": msg.header.frame_id or "odom",
            },
        }
        self._last_odom_ts = now

    def _on_voltage(self, msg: Float32) -> None:
        self._latest_voltage = float(msg.data)
        self._last_voltage_ts = time.time()

    def _on_imu(self, msg: Imu) -> None:
        now = time.time()
        self._latest_imu = {
            "ax": float(msg.linear_acceleration.x),
            "ay": float(msg.linear_acceleration.y),
            "az": float(msg.linear_acceleration.z),
            "gx": float(msg.angular_velocity.x),
            "gy": float(msg.angular_velocity.y),
            "gz": float(msg.angular_velocity.z),
            "oriQuat": [
                float(msg.orientation.x),
                float(msg.orientation.y),
                float(msg.orientation.z),
                float(msg.orientation.w),
            ],
        }
        self._last_imu_ts = now

    def build_telemetry(self, session_id: str, seq: int) -> dict[str, Any]:
        """Snapshot cached subscriber data into a TelemetryMessage dict.
        Schema: packages/shared/src/telemetry.ts (v1 additive).
        """
        now = time.time()
        msg: dict[str, Any] = {
            "kind": "telemetry",
            "v": 1,
            "ts": int(now * 1000),
            "vehicleId": VEHICLE_ID,
            "sessionId": session_id,
            "seq": seq,
        }

        # Stale-protection: omit a section if its source went silent > 5s
        if self._latest_odom and (now - self._last_odom_ts) < 5.0:
            msg["velocity"] = self._latest_odom["velocity"]
            msg["odom"] = self._latest_odom["odom"]

        if self._latest_voltage is not None and (now - self._last_voltage_ts) < 10.0:
            msg["battery"] = {
                "voltage": self._latest_voltage,
                "pct": _voltage_to_pct(self._latest_voltage),
            }

        if self._latest_imu and (now - self._last_imu_ts) < 5.0:
            msg["imu"] = self._latest_imu

        # Vehicle status — we can fill mode from publish_mode hint
        msg["vehicle"] = {
            "mode": "manual",  # Bridge assumes operator manual control
        }

        # First-frame capabilities advertisement (cockpit caches; later frames omit)
        if not self._caps_published:
            caps = []
            if self._latest_odom:
                caps += ["velocity", "odom"]
            if self._latest_voltage is not None:
                caps.append("battery")
            if self._latest_imu:
                caps.append("imu")
            caps.append("vehicle")
            msg["capabilities"] = caps
            self._caps_published = True

        return msg

    def publish_cmd(self, forward: float, lateral: float, yaw: float) -> None:
        """Delegate to vehicle adapter — adapter scales axes per its limits
        and publishes to whatever topic that vehicle needs."""
        self.adapter.publish_movement(forward, lateral, yaw)

    def publish_stop(self) -> None:
        """Delegate to vehicle adapter — adapter publishes zero on all its
        motor topics."""
        self.adapter.publish_emergency_stop()

    def publish_joy(self, axes: list[float], buttons: list[int]) -> None:
        """Republish raw gamepad state as sensor_msgs/Joy.

        teleop_twist_joy subscribes to /joy and maps axes → /cmd_vel per the
        YAML config in apps/r2-bridge/config/joy_mapping_xbox360.yaml.

        Spec: openspec/features/contract-c1-c8/c12-joystick-support.md §r2-bridge
        """
        msg = Joy()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = "joy"
        msg.axes = [float(v) for v in axes]
        msg.buttons = [int(v) for v in buttons]
        self._joy_pub.publish(msg)


class Watchdog:
    """Trip emergency_stop when operator heartbeat goes silent."""

    def __init__(self, timeout_s: float, on_timeout) -> None:
        self.timeout_s = timeout_s
        self.on_timeout = on_timeout
        self._last_beat: float | None = None
        self._task: asyncio.Task | None = None
        self._tripped = False

    def beat(self) -> None:
        loop = asyncio.get_running_loop()
        self._last_beat = loop.time()
        if self._tripped:
            log.info("heartbeat resumed — operator reconnected")
            self._tripped = False

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._loop())

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(0.5)
            if self._last_beat is None or self._tripped:
                continue
            elapsed = asyncio.get_running_loop().time() - self._last_beat
            if elapsed > self.timeout_s:
                log.warning(
                    "watchdog: %.1fs since last heartbeat → emergency_stop",
                    elapsed,
                )
                self._tripped = True
                self.on_timeout()


def _spin_rclpy(node: Node) -> None:
    """Run rclpy spin in a dedicated thread so asyncio main isn't blocked."""
    try:
        rclpy.spin(node)
    except Exception:  # noqa: BLE001 — thread top-level
        log.exception("rclpy spin crashed")


async def main() -> int:
    if not LIVEKIT_TOKEN:
        print("ERROR: LIVEKIT_TOKEN env var required", file=sys.stderr)
        return 2

    rclpy.init()
    log.info("BRIDGE_PUBLISH_MODE=%s", PUBLISH_MODE)
    # Pick adapter based on env (default = Wheeltec AMR for R2). Future:
    # ADAPTER=unitree_b2w → UnitreeB2WAdapter, etc.
    adapter_name = os.environ.get("VEHICLE_ADAPTER", "wheeltec_amr")
    if adapter_name == "wheeltec_amr":
        adapter = WheeltecAMRAdapter(
            publish_mode=PUBLISH_MODE,
            max_linear_ms=MAX_LINEAR_MS,
            max_angular_rads=MAX_ANGULAR_RADS,
        )
    else:
        raise SystemExit(f"unknown VEHICLE_ADAPTER={adapter_name!r}")
    pub = RosPublisher(adapter)
    rclpy_thread = threading.Thread(
        target=_spin_rclpy, args=(pub,), daemon=True, name="rclpy-spin"
    )
    rclpy_thread.start()

    room = rtc.Room()

    # Edge sessionId — fresh per process run. Used in safety_event envelopes
    # so operator UI can correlate events to this bridge instance.
    session_id = f"r2-bridge-{uuid.uuid4().hex[:8]}"
    safety_seq = 0

    async def publish_safety(event_name: str, reason: str | None = None) -> None:
        nonlocal safety_seq
        safety_seq += 1
        evt: dict[str, Any] = {
            "kind": "safety_event",
            "v": 1,
            "ts": int(time.time() * 1000),
            "vehicleId": VEHICLE_ID,
            "sessionId": session_id,
            "seq": safety_seq,
            "event": event_name,
        }
        if reason:
            evt["reason"] = reason
        payload = json.dumps(evt).encode("utf-8")
        try:
            await room.local_participant.publish_data(
                payload, reliable=True
            )
            log.info("safety_event %s (reason=%s)", event_name, reason)
        except Exception as e:  # noqa: BLE001
            log.warning("publish_safety failed: %s", e)

    def trigger_stop() -> None:
        """Heartbeat-watchdog or disconnect handler entry."""
        pub.publish_stop()
        asyncio.create_task(
            publish_safety("safe_mode_entered", reason="heartbeat_timeout")
        )

    watchdog = Watchdog(HEARTBEAT_TIMEOUT_S, on_timeout=trigger_stop)

    # Joy heartbeat watchdog — separate from operator heartbeat.
    # Per joystick-gates.md Gate 4: 100 ms timeout (much tighter than 3 s
    # movement watchdog; teleop is real-time). Fires emergency_stop + safety
    # event on timeout.
    JOY_WATCHDOG_TIMEOUT_S = float(os.environ.get("JOY_HEARTBEAT_TIMEOUT_S", "0.1"))

    async def on_joy_timeout() -> None:
        log.warning("joy watchdog: no joy frame for %.0f ms → stop", JOY_WATCHDOG_TIMEOUT_S * 1000)
        pub.publish_stop()
        await publish_safety("safe_mode_entered", reason="joystick_heartbeat_timeout")

    joy_watchdog: Watchdog | None = None  # created lazily on first joy frame

    nonlocal_state: dict[str, int] = {}

    @room.on("data_received")
    def on_data(packet: rtc.DataPacket) -> None:  # type: ignore[name-defined]
        try:
            cmd: dict[str, Any] = json.loads(packet.data.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            log.warning("malformed data packet: %s", e)
            return

        kind = cmd.get("type")
        if kind == "heartbeat":
            watchdog.beat()
            return
        if kind == "movement":
            axes = cmd.get("axes") or {}
            fwd = float(axes.get("forward", 0))
            lat = float(axes.get("lateral", 0))
            yaw = float(axes.get("yaw", 0))
            pub.publish_cmd(forward=fwd, lateral=lat, yaw=yaw)
            # Debug log (every ~10th to avoid spam at 8 Hz)
            nonlocal_state["mv_count"] = nonlocal_state.get("mv_count", 0) + 1
            if nonlocal_state["mv_count"] % 10 == 1:
                log.info("movement #%d fwd=%.2f lat=%.2f yaw=%.2f",
                         nonlocal_state["mv_count"], fwd, lat, yaw)
            return
        if kind == "joy":
            nonlocal joy_watchdog
            # Beat joy-specific watchdog (Gate 4 — 100 ms timeout).
            # Create lazily on first joy frame; subsequent frames just beat it.
            if joy_watchdog is None:
                joy_watchdog = Watchdog(
                    JOY_WATCHDOG_TIMEOUT_S,
                    on_timeout=lambda: asyncio.create_task(on_joy_timeout()),
                )
                joy_watchdog.start()
                log.info("joy watchdog started (timeout=%.0f ms)",
                         JOY_WATCHDOG_TIMEOUT_S * 1000)
            joy_watchdog.beat()
            # Decode joy payload and publish sensor_msgs/Joy → teleop_twist_joy
            joy_payload = cmd.get("joy") or {}
            joy_axes: list[float] = [float(v) for v in joy_payload.get("axes", [])]
            joy_buttons: list[int] = [int(v) for v in joy_payload.get("buttons", [])]
            pub.publish_joy(joy_axes, joy_buttons)
            # Debug log every ~20th frame (20 Hz → ~1/s)
            nonlocal_state["joy_count"] = nonlocal_state.get("joy_count", 0) + 1
            if nonlocal_state["joy_count"] % 20 == 1:
                log.info("joy #%d axes=%s buttons=%s",
                         nonlocal_state["joy_count"],
                         [f"{v:.2f}" for v in joy_axes[:6]],
                         joy_buttons[:8])
            return
        if kind == "emergency_stop":
            log.info("operator emergency_stop seq=%s", cmd.get("seq"))
            pub.publish_stop()
            asyncio.create_task(
                publish_safety("emergency_stop_acked", reason="operator")
            )
            return
        if kind == "resume_control":
            log.info("operator resume_control seq=%s", cmd.get("seq"))
            asyncio.create_task(
                publish_safety("safe_mode_left", reason="operator_resume")
            )
            return
        log.debug("ignored unknown type=%s", kind)

    @room.on("disconnected")
    def on_disconnected(reason: Any = None) -> None:
        log.warning("room disconnected (reason=%s) → stop", reason)
        pub.publish_stop()

    log.info("connecting to %s as room=%s", LIVEKIT_URL, VEHICLE_ID)
    try:
        await room.connect(LIVEKIT_URL, LIVEKIT_TOKEN)
    except Exception as e:  # noqa: BLE001 — surface clean exit, let systemd restart
        log.error("LiveKit connect failed: %s", e)
        rclpy.shutdown()
        return 1
    log.info("connected; awaiting commands sessionId=%s", session_id)
    # Announce edge online + immediately leave safe_mode so operator joystick
    # unlocks without manual Resume step. Demo subset — full ADR-009 manual
    # recovery flow will be wired in C9.6.
    await publish_safety("edge_online", reason="bridge_started")
    await publish_safety("safe_mode_left", reason="demo_auto_resume")
    watchdog.start()

    # ── Telemetry publish loop (5 Hz default) ─────────────────────────────
    telemetry_seq = 0

    async def telemetry_loop() -> None:
        nonlocal telemetry_seq
        period = 1.0 / max(1.0, TELEMETRY_HZ)
        log.info("telemetry loop started @ %.1f Hz", TELEMETRY_HZ)
        while True:
            await asyncio.sleep(period)
            try:
                msg = pub.build_telemetry(session_id, telemetry_seq)
                payload = json.dumps(msg).encode("utf-8")
                await room.local_participant.publish_data(payload, reliable=True)
                telemetry_seq += 1
            except Exception as e:  # noqa: BLE001
                log.debug("telemetry publish failed (will retry): %s", e)

    asyncio.create_task(telemetry_loop())

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop_event.set)
    await stop_event.wait()

    log.info("shutdown: publishing final stop + disconnecting")
    pub.publish_stop()
    await publish_safety("edge_disconnecting", reason="bridge_shutdown")
    await room.disconnect()
    rclpy.shutdown()
    return 0


if __name__ == "__main__":
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    sys.exit(asyncio.run(main()))
