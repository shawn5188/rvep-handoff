import { AccessToken, VideoGrant } from "livekit-server-sdk";

export type LivekitRole = "operator" | "viewer" | "admin";

export interface LivekitTokenResult {
  token: string;
  url: string;
  roomName: string;
  identity: string;
  expiresAt: Date;
}

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

function getLivekitConfig(): { apiKey: string; apiSecret: string; url: string } {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const url = process.env.LIVEKIT_URL;

  if (!apiKey || !apiSecret || !url) {
    throw new Error(
      "Missing LiveKit environment variables: LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL",
    );
  }

  return { apiKey, apiSecret, url };
}

/**
 * Issue a Livekit room access token scoped by role.
 *
 * Grants:
 *  operator  — roomJoin, canPublish, canPublishData, canSubscribe
 *  viewer    — roomJoin, canSubscribe (no publish)
 *  admin     — roomJoin, canPublish, canPublishData, canSubscribe (full access)
 */
export async function issueLivekitToken(
  userId: string,
  vehicleId: string,
  role: LivekitRole,
): Promise<LivekitTokenResult> {
  const { apiKey, apiSecret, url } = getLivekitConfig();

  const roomName = `ugv-${vehicleId}`;
  const identity = `${role}-${userId}`;
  const expiresAt = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);

  const grants = buildGrants(roomName, role);

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    ttl: TOKEN_TTL_SECONDS,
  });
  at.addGrant(grants);

  const token = await at.toJwt();

  return { token, url, roomName, identity, expiresAt };
}

/**
 * c15 P3 — issue a long-lived edge token for a vehicle deployment.
 * Publisher-grade grants (the edge publishes video + telemetry over the
 * DataChannel), custom identity + TTL. Used by the admin token-mint and
 * deploy-package endpoints; every mint is audit-logged by the caller.
 */
export async function issueVehicleEdgeToken(
  vehicleId: string,
  opts: { ttlSeconds: number; identity: string },
): Promise<LivekitTokenResult> {
  const { apiKey, apiSecret, url } = getLivekitConfig();

  const roomName = `ugv-${vehicleId}`;
  const expiresAt = new Date(Date.now() + opts.ttlSeconds * 1000);

  const at = new AccessToken(apiKey, apiSecret, {
    identity: opts.identity,
    ttl: opts.ttlSeconds,
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canSubscribe: true,
    canPublish: true,
    canPublishData: true,
  });

  const token = await at.toJwt();

  return { token, url, roomName, identity: opts.identity, expiresAt };
}

function buildGrants(roomName: string, role: LivekitRole): VideoGrant {
  const base: VideoGrant = {
    roomJoin: true,
    room: roomName,
    canSubscribe: true,
  };

  switch (role) {
    case "operator":
      return { ...base, canPublish: true, canPublishData: true };
    case "viewer":
      return { ...base, canPublish: false, canPublishData: false };
    case "admin":
      return { ...base, canPublish: true, canPublishData: true };
  }
}
