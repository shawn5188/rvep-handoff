import { describe, it, expect } from "vitest";
import { gunzipSync } from "zlib";
import { prisma } from "@/lib/db";
import { Role } from "@prisma/client";
import {
  GET as LIST,
  POST as CREATE,
} from "@/app/api/v1/admin/vehicles/route";
import {
  GET as DETAIL,
  PATCH as UPDATE,
  DELETE as ARCHIVE,
} from "@/app/api/v1/admin/vehicles/[id]/route";
import { POST as MINT_TOKEN } from "@/app/api/v1/admin/vehicles/[id]/token/route";
import { GET as DEPLOY_PACKAGE } from "@/app/api/v1/admin/vehicles/[id]/deploy-package/route";
import { GET as ADAPTER_TYPES } from "@/app/api/v1/admin/adapter-types/route";
import { makeRequest, parseJson } from "../request-helpers";
import { createUser, createVehicle, loginAs, bearerHeader } from "../factories";

type IdCtx = { params: Promise<{ id: string }> };
function idParams(id: string): IdCtx {
  return { params: Promise.resolve({ id }) };
}

async function adminToken(): Promise<string> {
  const admin = await createUser({ role: Role.ADMIN });
  return loginAs(admin.id, admin.role);
}

const CREATE_BODY = {
  vehicleId: "amr-99",
  displayName: "AMR-99",
  vehicleType: "WHEELED",
  adapterType: "r2-bridge",
  platformId: "up-board-n3350",
  cameraProfileId: "c270-vaapi-720p",
  audioProfileId: "none",
  vendor: "Wheeltec",
  serialNumber: "WT-2026-099",
  maxLinearMs: 0.3,
  maxAngularRads: 0.8,
};

describe("Admin Vehicle CRUD (c15 P3)", () => {
  describe("POST /admin/vehicles", () => {
    it("creates a vehicle, sets createdBy + adapter default capabilities, audits", async () => {
      const admin = await createUser({ role: Role.ADMIN });
      const token = await loginAs(admin.id, admin.role);

      const res = await CREATE(
        makeRequest("/api/v1/admin/vehicles", {
          method: "POST",
          headers: bearerHeader(token),
          body: CREATE_BODY,
        }),
        undefined,
      );
      const body = await parseJson<{ data: Record<string, unknown> }>(res);

      expect(res.status).toBe(201);
      expect(body.data.vehicleId).toBe("amr-99");
      expect(body.data.createdBy).toBe(admin.id);
      // declaredCapabilities omitted → adapter defaults applied.
      expect(body.data.declaredCapabilities).toEqual([
        "cmd_vel",
        "telemetry",
        "video_h264",
      ]);
      expect(body.data.activeSessionCount).toBe(0);
      expect(body.data.hasActiveLease).toBe(false);

      const event = await prisma.eventLog.findFirst({
        where: { eventName: "vehicle_created", actorId: admin.id },
      });
      expect(event).not.toBeNull();
      expect(event?.targetId).toBe("amr-99");
    });

    it("returns 409 vehicle_id_taken on duplicate vehicleId", async () => {
      const token = await adminToken();
      const first = await CREATE(
        makeRequest("/api/v1/admin/vehicles", {
          method: "POST",
          headers: bearerHeader(token),
          body: CREATE_BODY,
        }),
        undefined,
      );
      expect(first.status).toBe(201);

      const dup = await CREATE(
        makeRequest("/api/v1/admin/vehicles", {
          method: "POST",
          headers: bearerHeader(token),
          body: CREATE_BODY,
        }),
        undefined,
      );
      const body = await parseJson<{ error: string }>(dup);
      expect(dup.status).toBe(409);
      expect(body.error).toBe("vehicle_id_taken");
    });

    it("rejects unknown adapterType (422) and non-admin caller (403)", async () => {
      const token = await adminToken();
      const badAdapter = await CREATE(
        makeRequest("/api/v1/admin/vehicles", {
          method: "POST",
          headers: bearerHeader(token),
          body: { ...CREATE_BODY, adapterType: "no-such-adapter" },
        }),
        undefined,
      );
      expect(badAdapter.status).toBe(422);

      const op = await createUser({ role: Role.OPERATOR });
      const opToken = await loginAs(op.id, op.role);
      const forbidden = await CREATE(
        makeRequest("/api/v1/admin/vehicles", {
          method: "POST",
          headers: bearerHeader(opToken),
          body: CREATE_BODY,
        }),
        undefined,
      );
      expect(forbidden.status).toBe(403);
    });

    it("rejects adapter ↔ vehicleType mismatch (422)", async () => {
      const token = await adminToken();
      const res = await CREATE(
        makeRequest("/api/v1/admin/vehicles", {
          method: "POST",
          headers: bearerHeader(token),
          body: { ...CREATE_BODY, vehicleType: "DRONE" }, // r2-bridge is WHEELED-only
        }),
        undefined,
      );
      const body = await parseJson<{ error: string }>(res);
      expect(res.status).toBe(422);
      expect(body.error).toBe("adapter_vehicle_type_mismatch");
    });
  });

  describe("GET /admin/vehicles", () => {
    it("hides archived vehicles unless includeArchived=1", async () => {
      const token = await adminToken();
      const active = await createVehicle("active");
      const archived = await createVehicle("archived");
      await prisma.vehicle.update({
        where: { id: archived.id },
        data: { archivedAt: new Date() },
      });

      const res = await LIST(
        makeRequest("/api/v1/admin/vehicles", { headers: bearerHeader(token) }),
        undefined,
      );
      const body = await parseJson<{ data: Array<{ vehicleId: string }> }>(res);
      expect(res.status).toBe(200);
      const ids = body.data.map((v) => v.vehicleId);
      expect(ids).toContain(active.vehicleId);
      expect(ids).not.toContain(archived.vehicleId);

      const resAll = await LIST(
        makeRequest("/api/v1/admin/vehicles?includeArchived=1", {
          headers: bearerHeader(token),
        }),
        undefined,
      );
      const bodyAll = await parseJson<{ data: Array<{ vehicleId: string }> }>(resAll);
      expect(bodyAll.data.map((v) => v.vehicleId)).toContain(archived.vehicleId);
    });
  });

  describe("GET/PATCH/DELETE /admin/vehicles/:id", () => {
    it("GET returns detail with usage snapshot arrays", async () => {
      const token = await adminToken();
      const vehicle = await createVehicle("detail");

      const res = await DETAIL(
        makeRequest(`/api/v1/admin/vehicles/${vehicle.vehicleId}`, {
          headers: bearerHeader(token),
        }),
        idParams(vehicle.vehicleId),
      );
      const body = await parseJson<{
        data: { vehicleId: string; recentLeases: unknown[]; recentSessions: unknown[] };
      }>(res);

      expect(res.status).toBe(200);
      expect(body.data.vehicleId).toBe(vehicle.vehicleId);
      expect(body.data.recentLeases).toEqual([]);
      expect(body.data.recentSessions).toEqual([]);
    });

    it("GET unknown id → 404", async () => {
      const token = await adminToken();
      const res = await DETAIL(
        makeRequest("/api/v1/admin/vehicles/nope", { headers: bearerHeader(token) }),
        idParams("nope"),
      );
      expect(res.status).toBe(404);
    });

    it("PATCH updates fields and audits a diff; immutable fields are rejected", async () => {
      const admin = await createUser({ role: Role.ADMIN });
      const token = await loginAs(admin.id, admin.role);
      const vehicle = await createVehicle("patch");

      const res = await UPDATE(
        makeRequest(`/api/v1/admin/vehicles/${vehicle.vehicleId}`, {
          method: "PATCH",
          headers: bearerHeader(token),
          body: { displayName: "Renamed", maxLinearMs: 1.2 },
        }),
        idParams(vehicle.vehicleId),
      );
      const body = await parseJson<{ data: { displayName: string; maxLinearMs: number } }>(res);
      expect(res.status).toBe(200);
      expect(body.data.displayName).toBe("Renamed");
      expect(body.data.maxLinearMs).toBe(1.2);

      const event = await prisma.eventLog.findFirst({
        where: { eventName: "vehicle_updated", actorId: admin.id },
      });
      expect(event).not.toBeNull();
      const diff = (event?.payload as { diff: Record<string, unknown> }).diff;
      expect(Object.keys(diff).sort()).toEqual(["displayName", "maxLinearMs"]);

      // vehicleId is immutable — strict schema rejects it.
      const immutable = await UPDATE(
        makeRequest(`/api/v1/admin/vehicles/${vehicle.vehicleId}`, {
          method: "PATCH",
          headers: bearerHeader(token),
          body: { vehicleId: "hacked-id" },
        }),
        idParams(vehicle.vehicleId),
      );
      expect(immutable.status).toBe(422);
    });

    it("DELETE soft-deletes (archivedAt set, row retained), double-archive → 409", async () => {
      const admin = await createUser({ role: Role.ADMIN });
      const token = await loginAs(admin.id, admin.role);
      const vehicle = await createVehicle("archive-me");

      const res = await ARCHIVE(
        makeRequest(`/api/v1/admin/vehicles/${vehicle.vehicleId}`, {
          method: "DELETE",
          headers: bearerHeader(token),
        }),
        idParams(vehicle.vehicleId),
      );
      const body = await parseJson<{ data: { archivedAt: string | null } }>(res);
      expect(res.status).toBe(200);
      expect(body.data.archivedAt).not.toBeNull();

      // Row still exists — sessions/audit history preserved.
      const row = await prisma.vehicle.findUnique({ where: { id: vehicle.id } });
      expect(row).not.toBeNull();
      expect(row?.archivedAt).not.toBeNull();

      const event = await prisma.eventLog.findFirst({
        where: { eventName: "vehicle_archived", actorId: admin.id },
      });
      expect(event?.targetId).toBe(vehicle.vehicleId);

      const again = await ARCHIVE(
        makeRequest(`/api/v1/admin/vehicles/${vehicle.vehicleId}`, {
          method: "DELETE",
          headers: bearerHeader(token),
        }),
        idParams(vehicle.vehicleId),
      );
      expect(again.status).toBe(409);
    });
  });

  describe("POST /admin/vehicles/:id/token", () => {
    it("mints an edge token (default identity + 24h TTL) and audits", async () => {
      const admin = await createUser({ role: Role.ADMIN });
      const token = await loginAs(admin.id, admin.role);
      const vehicle = await createVehicle("token");

      const before = Date.now();
      const res = await MINT_TOKEN(
        makeRequest(`/api/v1/admin/vehicles/${vehicle.vehicleId}/token`, {
          method: "POST",
          headers: bearerHeader(token),
        }),
        idParams(vehicle.vehicleId),
      );
      const body = await parseJson<{
        data: { token: string; expiresAt: string; roomName: string; identity: string; url: string };
      }>(res);

      expect(res.status).toBe(200);
      expect(body.data.token.length).toBeGreaterThan(20);
      expect(body.data.roomName).toBe(`ugv-${vehicle.vehicleId}`);
      expect(body.data.identity).toBe("vehicle-edge");
      const ttlMs = new Date(body.data.expiresAt).getTime() - before;
      expect(ttlMs).toBeGreaterThan(23.5 * 60 * 60 * 1000);
      expect(ttlMs).toBeLessThan(24.5 * 60 * 60 * 1000);

      const event = await prisma.eventLog.findFirst({
        where: { eventName: "vehicle_token_minted", actorId: admin.id },
      });
      expect(event?.payload).toMatchObject({ ttl: 86400, identity: "vehicle-edge" });
    });

    it("accepts TTL/identity override, rejects out-of-range TTL", async () => {
      const token = await adminToken();
      const vehicle = await createVehicle("token-override");

      const res = await MINT_TOKEN(
        makeRequest(`/api/v1/admin/vehicles/${vehicle.vehicleId}/token`, {
          method: "POST",
          headers: bearerHeader(token),
          body: { ttlSeconds: 7 * 86400, identity: "edge-cam" },
        }),
        idParams(vehicle.vehicleId),
      );
      const body = await parseJson<{ data: { identity: string } }>(res);
      expect(res.status).toBe(200);
      expect(body.data.identity).toBe("edge-cam");

      const bad = await MINT_TOKEN(
        makeRequest(`/api/v1/admin/vehicles/${vehicle.vehicleId}/token`, {
          method: "POST",
          headers: bearerHeader(token),
          body: { ttlSeconds: 10 }, // below 60 s floor
        }),
        idParams(vehicle.vehicleId),
      );
      expect(bad.status).toBe(422);
    });
  });

  describe("GET /admin/vehicles/:id/deploy-package", () => {
    it("returns a tar.gz containing env files + README, and audits", async () => {
      const admin = await createUser({ role: Role.ADMIN });
      const token = await loginAs(admin.id, admin.role);
      const vehicle = await createVehicle("deploy");

      const res = await DEPLOY_PACKAGE(
        makeRequest(`/api/v1/admin/vehicles/${vehicle.vehicleId}/deploy-package`, {
          headers: bearerHeader(token),
        }),
        idParams(vehicle.vehicleId),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/gzip");
      expect(res.headers.get("content-disposition")).toContain(
        `${vehicle.vehicleId}-deploy.tar.gz`,
      );

      const gz = Buffer.from(await res.arrayBuffer());
      expect(gz[0]).toBe(0x1f); // gzip magic
      expect(gz[1]).toBe(0x8b);

      const tar = gunzipSync(gz).toString("utf8");
      expect(tar).toContain(`${vehicle.vehicleId}/r2-bridge.env`);
      expect(tar).toContain(`VEHICLE_ID=${vehicle.vehicleId}`);
      expect(tar).toContain("LIVEKIT_TOKEN=");
      expect(tar).toContain(`${vehicle.vehicleId}/README.md`);
      // factory vehicle has a cameraProfileId → camera env included
      expect(tar).toContain(`${vehicle.vehicleId}/r2-camera.env`);

      const event = await prisma.eventLog.findFirst({
        where: { eventName: "vehicle_deploy_package_generated", actorId: admin.id },
      });
      expect(event?.targetId).toBe(vehicle.vehicleId);
    });
  });

  describe("GET /admin/adapter-types", () => {
    it("returns the in-code registry with metadata + capability superset", async () => {
      const token = await adminToken();
      const res = await ADAPTER_TYPES(
        makeRequest("/api/v1/admin/adapter-types", { headers: bearerHeader(token) }),
        undefined,
      );
      const body = await parseJson<{
        data: {
          adapterTypes: Array<{ id: string; displayName: string; defaultCapabilities: string[] }>;
          allCapabilities: string[];
        };
      }>(res);

      expect(res.status).toBe(200);
      const ids = body.data.adapterTypes.map((a) => a.id);
      expect(ids).toContain("r2-bridge");
      expect(ids).toContain("mock-edge");
      expect(ids).toContain("edge-publisher-go");
      expect(body.data.allCapabilities).toContain("cmd_vel");
    });
  });
});
