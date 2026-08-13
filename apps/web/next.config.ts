import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Disabled to avoid double mount of LiveKit Room in dev (causes connect/disconnect storm).
  // Re-enable once we add an idempotent guard for room creation.
  reactStrictMode: false,
  // Move Next dev overlay to top-right so it does not cover the bottom-left
  // touch joystick during mobile cockpit dev. Keep enabled — we want to see
  // build/route status during development.
  devIndicators: {
    position: "top-right",
  },
};

export default nextConfig;
