import { VehicleType } from "@prisma/client";

/**
 * c15 P3 — in-code adapter type registry.
 *
 * Deliberately NOT a DB table for this phase (per c15 spec §Vehicle endpoints):
 * the set of supported edge adapters changes with code deployments, not with
 * admin actions, so a const keeps registry and adapter implementations in the
 * same review surface. Revisit DB-backed registry at P4+/v3 when third-party
 * adapters can be registered without a platform deploy.
 */

export interface AdapterType {
  id: string;
  displayName: string;
  description: string;
  defaultCapabilities: string[];
  /** VehicleTypes this adapter can drive — UI restricts the dropdown pairing. */
  vehicleTypes: VehicleType[];
}

export const ADAPTER_REGISTRY: AdapterType[] = [
  {
    id: "r2-bridge",
    displayName: "R2 Wheeltec Bridge",
    description:
      "Python ROS2 bridge for Wheeltec AMR (differential drive + camera)",
    defaultCapabilities: ["cmd_vel", "telemetry", "video_h264"],
    vehicleTypes: [VehicleType.WHEELED],
  },
  {
    id: "mock-edge",
    displayName: "Mock Edge (dev/sim)",
    description: "TypeScript mock edge agent for local dev + AMR-01 simulation",
    defaultCapabilities: ["cmd_vel", "telemetry", "video_h264", "joy"],
    vehicleTypes: [VehicleType.WHEELED, VehicleType.RC_CAR],
  },
  {
    id: "edge-publisher-go",
    displayName: "AGX Orin NVENC Publisher",
    description:
      "Go publisher for ZED-X + NVENC pipeline (paired with mock-edge control)",
    defaultCapabilities: ["video_h264_hw_encoded"],
    vehicleTypes: [
      VehicleType.WHEELED,
      VehicleType.QUADRUPED,
      VehicleType.WHEELED_QUADRUPED,
      VehicleType.CUSTOM,
    ],
  },
  {
    id: "generic_ros2_cmd_vel",
    displayName: "Generic ROS2 cmd_vel",
    description:
      "Generic ROS2 Twist adapter — any base that consumes geometry_msgs/Twist",
    defaultCapabilities: ["cmd_vel", "telemetry"],
    vehicleTypes: [
      VehicleType.WHEELED,
      VehicleType.QUADRUPED,
      VehicleType.WHEELED_QUADRUPED,
      VehicleType.RC_CAR,
      VehicleType.DRONE,
      VehicleType.CUSTOM,
    ],
  },
];

export function findAdapterType(id: string): AdapterType | undefined {
  return ADAPTER_REGISTRY.find((a) => a.id === id);
}

/** Union of every capability any registered adapter declares (for UI pickers). */
export function allKnownCapabilities(): string[] {
  const set = new Set<string>();
  for (const adapter of ADAPTER_REGISTRY) {
    for (const cap of adapter.defaultCapabilities) set.add(cap);
  }
  return [...set].sort();
}
