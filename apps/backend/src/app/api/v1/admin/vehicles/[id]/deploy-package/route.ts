import { withAdmin } from "@/middleware/require-admin";
import { UnprocessableEntity } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import { issueVehicleEdgeToken } from "@/lib/livekit";
import { findVehicleOr404 } from "@/lib/admin-vehicle-serializer";
import { buildTarGz, TarEntry } from "@/lib/tar";

/**
 * c15 P3 — GET /api/v1/admin/vehicles/:id/deploy-package[?ttlSeconds=N]
 *
 * Generates the on-vehicle deployment bundle as <vehicleId>-deploy.tar.gz:
 *   <vehicleId>/r2-bridge.env   env file consumed by systemd r2-bridge.service
 *                               (LIVEKIT_URL / LIVEKIT_TOKEN / VEHICLE_ID /
 *                                ROS_DOMAIN_ID / MAX_LINEAR_MS / MAX_ANGULAR_RADS)
 *   <vehicleId>/r2-camera.env   only when the vehicle has a cameraProfileId
 *   <vehicleId>/README.md       per-vehicle install SOP + token expiry
 *
 * A fresh edge token is minted per download (default TTL 7 days) — every
 * download is therefore audit-logged as vehicle_deploy_package_generated.
 * Archive built with the stdlib tar/gzip helper (no archiver dependency).
 */

type Ctx = { params: Promise<{ id: string }> };

const DAY_S = 24 * 60 * 60;
const DEFAULT_TTL_S = 7 * DAY_S;
const MAX_TTL_S = 30 * DAY_S;

export const GET = withAdmin<Ctx>(async (request, auth, context) => {
  const { id } = await context.params;
  const vehicle = await findVehicleOr404(id);

  const ttlParam = new URL(request.url).searchParams.get("ttlSeconds");
  const ttlSeconds = ttlParam === null ? DEFAULT_TTL_S : Number(ttlParam);
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 60 ||
    ttlSeconds > MAX_TTL_S
  ) {
    throw new UnprocessableEntity("invalid_ttl", { min: 60, max: MAX_TTL_S });
  }

  const identity = "vehicle-edge";
  const minted = await issueVehicleEdgeToken(vehicle.vehicleId, {
    ttlSeconds,
    identity,
  });

  const dir = vehicle.vehicleId;
  const entries: TarEntry[] = [
    {
      name: `${dir}/r2-bridge.env`,
      mode: 0o600, // contains the LiveKit token
      content: envFile({
        LIVEKIT_URL: minted.url,
        LIVEKIT_TOKEN: minted.token,
        VEHICLE_ID: vehicle.vehicleId,
        ROS_DOMAIN_ID: "0",
        MAX_LINEAR_MS: String(vehicle.maxLinearMs),
        MAX_ANGULAR_RADS: String(vehicle.maxAngularRads),
      }),
    },
  ];

  if (vehicle.cameraProfileId) {
    entries.push({
      name: `${dir}/r2-camera.env`,
      mode: 0o600,
      content: envFile({
        LIVEKIT_URL: minted.url,
        LIVEKIT_TOKEN: minted.token,
        VEHICLE_ID: vehicle.vehicleId,
        CAMERA_PROFILE_ID: vehicle.cameraProfileId,
      }),
    });
  }

  entries.push({
    name: `${dir}/README.md`,
    content: readme(vehicle.vehicleId, vehicle.displayName, {
      roomName: minted.roomName,
      identity: minted.identity,
      expiresAt: minted.expiresAt,
      hasCameraEnv: Boolean(vehicle.cameraProfileId),
    }),
  });

  await logAudit({
    actorId: auth.userId,
    eventName: "vehicle_deploy_package_generated",
    targetType: "Vehicle",
    targetId: vehicle.vehicleId,
    payload: { ttl: ttlSeconds, identity, expiresAt: minted.expiresAt.toISOString() },
  });

  const archive = buildTarGz(entries);
  return new Response(new Uint8Array(archive), {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${vehicle.vehicleId}-deploy.tar.gz"`,
      "Cache-Control": "no-store",
    },
  });
});

function envFile(vars: Record<string, string>): string {
  return (
    Object.entries(vars)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n"
  );
}

function readme(
  vehicleId: string,
  displayName: string,
  info: {
    roomName: string;
    identity: string;
    expiresAt: Date;
    hasCameraEnv: boolean;
  },
): string {
  const expiry = info.expiresAt.toISOString();
  return `# ${displayName} (${vehicleId}) — 車端部署套件

| 項目 | 值 |
|---|---|
| Vehicle ID | \`${vehicleId}\` |
| LiveKit room | \`${info.roomName}\` |
| Edge identity | \`${info.identity}\` |
| Token 到期 | \`${expiry}\` |

## 安裝步驟

\`\`\`bash
# 1. 複製 env 到車上（token 檔案，權限維持 600）
sudo mkdir -p /etc/rvep
sudo cp r2-bridge.env /etc/rvep/r2-bridge.env
sudo chmod 600 /etc/rvep/r2-bridge.env
${info.hasCameraEnv ? "sudo cp r2-camera.env /etc/rvep/r2-camera.env\nsudo chmod 600 /etc/rvep/r2-camera.env\n" : ""}
# 2. 重啟 bridge 服務
sudo systemctl restart r2-bridge
${info.hasCameraEnv ? "sudo systemctl restart r2-camera\n" : ""}
# 3. 驗證
systemctl status r2-bridge --no-pager
journalctl -u r2-bridge -n 30 --no-pager
\`\`\`

## 注意

- Token 到期（\`${expiry}\`）前請從 Admin Console 重新下載套件或重簽 token。
- env 檔含有連線憑證，請勿 commit 進版本控制或外流。
- ROS_DOMAIN_ID 預設 0；若車上 ROS2 網段不同請自行修改後重啟服務。
`;
}
