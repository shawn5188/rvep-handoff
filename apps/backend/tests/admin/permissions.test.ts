import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { Role } from "@prisma/client";
import { GET as GET_USER_PERMS, PUT as PUT_PERMS } from "@/app/api/v1/admin/permissions/route";
import { GET as GET_MATRIX } from "@/app/api/v1/admin/permissions/matrix/route";
import { makeRequest, parseJson } from "../request-helpers";
import {
  createUser,
  createVehicle,
  createPermission,
  loginAs,
  bearerHeader,
} from "../factories";

async function adminActor() {
  const admin = await createUser({ role: Role.ADMIN });
  const token = await loginAs(admin.id, admin.role);
  return { admin, token };
}

function getPerms(token: string, userId: string) {
  return GET_USER_PERMS(
    makeRequest(`/api/v1/admin/permissions?userId=${userId}`, {
      headers: bearerHeader(token),
    }),
    undefined,
  );
}

function putPerms(token: string, body: unknown) {
  return PUT_PERMS(
    makeRequest("/api/v1/admin/permissions", {
      method: "PUT",
      headers: bearerHeader(token),
      body,
    }),
    undefined,
  );
}

interface PermsPayload {
  data: {
    userId: string;
    userEmail: string;
    userRole: string;
    permissions: Array<{
      vehicleId: string;
      vehicleExternalId: string;
      vehicleDisplayName: string;
      vehicleStatus: string;
      role: string;
      priorityOverride: number | null;
      grantedBy: string | null;
      grantedByEmail: string | null;
      updatedAt: string;
    }>;
    availableVehicles: Array<{
      vehicleId: string;
      vehicleExternalId: string;
      displayName: string;
      vehicleType: string;
      status: string;
    }>;
  };
}

describe("Admin Permission Matrix (c15 P5)", () => {
  describe("GET /admin/permissions?userId=X", () => {
    it("returns granted permissions + availableVehicles for the rest", async () => {
      const { admin, token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const granted = await createVehicle("perm-granted");
      const free = await createVehicle("perm-free");
      await createPermission(user.id, granted.id, Role.OPERATOR, admin.id);
      await prisma.vehiclePermission.update({
        where: { userId_vehicleId: { userId: user.id, vehicleId: granted.id } },
        data: { priorityOverride: 80 },
      });

      const res = await getPerms(token, user.id);
      const json = await parseJson<PermsPayload>(res);

      expect(res.status).toBe(200);
      expect(json.data.userId).toBe(user.id);
      expect(json.data.userEmail).toBe(user.email);
      expect(json.data.userRole).toBe("OPERATOR");

      expect(json.data.permissions).toHaveLength(1);
      const p = json.data.permissions[0];
      expect(p.vehicleId).toBe(granted.id); // internal UUID, matches PUT input
      expect(p.vehicleExternalId).toBe(granted.vehicleId);
      expect(p.vehicleDisplayName).toBe(granted.displayName);
      expect(p.role).toBe("OPERATOR");
      expect(p.priorityOverride).toBe(80);
      expect(p.grantedBy).toBe(admin.id);
      expect(p.grantedByEmail).toBe(admin.email);

      const availableIds = json.data.availableVehicles.map((v) => v.vehicleId);
      expect(availableIds).toContain(free.id);
      expect(availableIds).not.toContain(granted.id);
    });

    it("excludes archived vehicles from availableVehicles", async () => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const archived = await createVehicle("perm-archived");
      await prisma.vehicle.update({
        where: { id: archived.id },
        data: { archivedAt: new Date() },
      });

      const res = await getPerms(token, user.id);
      const json = await parseJson<PermsPayload>(res);
      expect(res.status).toBe(200);
      expect(json.data.availableVehicles.map((v) => v.vehicleId)).not.toContain(
        archived.id,
      );
    });

    it("422 on missing / non-uuid userId, 404 on unknown user", async () => {
      const { token } = await adminActor();

      const missing = await GET_USER_PERMS(
        makeRequest("/api/v1/admin/permissions", { headers: bearerHeader(token) }),
        undefined,
      );
      expect(missing.status).toBe(422);

      const unknown = await getPerms(token, "00000000-0000-4000-8000-000000000000");
      expect(unknown.status).toBe(404);
    });

    it("rejects non-admin callers with 403", async () => {
      const op = await createUser({ role: Role.OPERATOR });
      const token = await loginAs(op.id, op.role);
      const res = await getPerms(token, op.id);
      expect(res.status).toBe(403);
    });
  });

  describe("GET /admin/permissions/matrix", () => {
    it("returns users × vehicles × permissions, excluding archived rows", async () => {
      const { admin, token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const archivedUser = await createUser({ role: Role.VIEWER });
      await prisma.user.update({
        where: { id: archivedUser.id },
        data: { archivedAt: new Date() },
      });
      const vehicle = await createVehicle("matrix-v1");
      const archivedVehicle = await createVehicle("matrix-arch");
      await prisma.vehicle.update({
        where: { id: archivedVehicle.id },
        data: { archivedAt: new Date() },
      });
      await createPermission(user.id, vehicle.id, Role.OPERATOR, admin.id);

      const res = await GET_MATRIX(
        makeRequest("/api/v1/admin/permissions/matrix", {
          headers: bearerHeader(token),
        }),
        undefined,
      );
      const json = await parseJson<{
        data: {
          users: Array<{ userId: string; email: string; role: string }>;
          vehicles: Array<{ vehicleId: string; vehicleExternalId: string }>;
          permissions: Array<{
            userId: string;
            vehicleId: string;
            role: string;
            priorityOverride: number | null;
            grantedBy: string | null;
          }>;
          totalUsers: number;
        };
      }>(res);

      expect(res.status).toBe(200);
      const userIds = json.data.users.map((u) => u.userId);
      expect(userIds).toContain(admin.id);
      expect(userIds).toContain(user.id);
      expect(userIds).not.toContain(archivedUser.id);
      expect(json.data.totalUsers).toBe(2);

      const vehicleIds = json.data.vehicles.map((v) => v.vehicleId);
      expect(vehicleIds).toContain(vehicle.id);
      expect(vehicleIds).not.toContain(archivedVehicle.id);

      expect(json.data.permissions).toEqual([
        {
          userId: user.id,
          vehicleId: vehicle.id,
          role: "OPERATOR",
          priorityOverride: null,
          grantedBy: admin.id,
        },
      ]);
    });

    it("paginates on the user axis and rejects bad params", async () => {
      const { token } = await adminActor();
      await createUser({ role: Role.OPERATOR });

      const page = await GET_MATRIX(
        makeRequest("/api/v1/admin/permissions/matrix?limit=1&offset=1", {
          headers: bearerHeader(token),
        }),
        undefined,
      );
      const json = await parseJson<{
        data: { users: unknown[]; totalUsers: number; limit: number; offset: number };
      }>(page);
      expect(page.status).toBe(200);
      expect(json.data.users).toHaveLength(1);
      expect(json.data.totalUsers).toBe(2);
      expect(json.data.limit).toBe(1);
      expect(json.data.offset).toBe(1);

      const bad = await GET_MATRIX(
        makeRequest("/api/v1/admin/permissions/matrix?limit=0", {
          headers: bearerHeader(token),
        }),
        undefined,
      );
      expect(bad.status).toBe(422);
    });

    it("rejects non-admin callers with 403", async () => {
      const op = await createUser({ role: Role.OPERATOR });
      const token = await loginAs(op.id, op.role);
      const res = await GET_MATRIX(
        makeRequest("/api/v1/admin/permissions/matrix", {
          headers: bearerHeader(token),
        }),
        undefined,
      );
      expect(res.status).toBe(403);
    });
  });

  describe("PUT /admin/permissions — full replace", () => {
    it("applies add / remove / role change / priority change in one atomic call", async () => {
      const { admin, token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const v1 = await createVehicle("put-v1"); // will be removed
      const v2 = await createVehicle("put-v2"); // role change
      const v3 = await createVehicle("put-v3"); // priority change
      const v4 = await createVehicle("put-v4"); // added
      await createPermission(user.id, v1.id, Role.OPERATOR, admin.id);
      await createPermission(user.id, v2.id, Role.OPERATOR, admin.id);
      await createPermission(user.id, v3.id, Role.OPERATOR, admin.id);
      await prisma.vehiclePermission.update({
        where: { userId_vehicleId: { userId: user.id, vehicleId: v3.id } },
        data: { priorityOverride: 30 },
      });

      const res = await putPerms(token, {
        userId: user.id,
        permissions: [
          { vehicleId: v2.id, role: "VIEWER" },
          { vehicleId: v3.id, role: "OPERATOR", priorityOverride: 60 },
          { vehicleId: v4.id, role: "OPERATOR", priorityOverride: 100 },
        ],
      });
      const json = await parseJson<PermsPayload>(res);

      expect(res.status).toBe(200);
      // PUT echoes the same shape as GET.
      const byVehicle = new Map(json.data.permissions.map((p) => [p.vehicleId, p]));
      expect(byVehicle.size).toBe(3);
      expect(byVehicle.has(v1.id)).toBe(false);
      expect(byVehicle.get(v2.id)).toMatchObject({ role: "VIEWER", priorityOverride: null });
      expect(byVehicle.get(v3.id)).toMatchObject({ role: "OPERATOR", priorityOverride: 60 });
      expect(byVehicle.get(v4.id)).toMatchObject({
        role: "OPERATOR",
        priorityOverride: 100,
        grantedBy: admin.id,
      });
      expect(json.data.availableVehicles.map((v) => v.vehicleId)).toContain(v1.id);

      const rows = await prisma.vehiclePermission.findMany({
        where: { userId: user.id },
      });
      expect(rows).toHaveLength(3);
      // Changed rows record the acting admin as the new granter.
      expect(rows.every((r) => r.grantedBy === admin.id)).toBe(true);
    });

    it("writes a user_permissions_updated audit row with counts + top-3 examples", async () => {
      const { admin, token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const v1 = await createVehicle("audit-v1");
      const v2 = await createVehicle("audit-v2");
      await createPermission(user.id, v1.id, Role.OPERATOR, admin.id);

      const res = await putPerms(token, {
        userId: user.id,
        permissions: [
          { vehicleId: v1.id, role: "VIEWER", priorityOverride: 10 },
          { vehicleId: v2.id, role: "OPERATOR" },
        ],
      });
      expect(res.status).toBe(200);

      const event = await prisma.eventLog.findFirst({
        where: { eventName: "user_permissions_updated", actorId: admin.id },
      });
      expect(event).not.toBeNull();
      expect(event?.targetType).toBe("User");
      expect(event?.targetId).toBe(user.id);
      expect(event?.payload).toMatchObject({
        email: user.email,
        added: 1,
        removed: 0,
        changed: 1,
        examples: {
          added: [
            { vehicleId: v2.vehicleId, role: "OPERATOR", priorityOverride: null },
          ],
          removed: [],
          changed: [
            {
              vehicleId: v1.vehicleId,
              from: { role: "OPERATOR", priorityOverride: null },
              to: { role: "VIEWER", priorityOverride: 10 },
            },
          ],
        },
      });
    });

    it("no-op PUT writes no user_permissions_updated audit row", async () => {
      const { admin, token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const v1 = await createVehicle("noop-v1");
      await createPermission(user.id, v1.id, Role.OPERATOR, admin.id);

      const res = await putPerms(token, {
        userId: user.id,
        permissions: [{ vehicleId: v1.id, role: "OPERATOR", priorityOverride: null }],
      });
      expect(res.status).toBe(200);

      const count = await prisma.eventLog.count({
        where: { eventName: "user_permissions_updated" },
      });
      expect(count).toBe(0);
    });

    it("400 cannot_edit_own_permissions when an admin targets themselves", async () => {
      const { admin, token } = await adminActor();
      const v = await createVehicle("self-v");
      const res = await putPerms(token, {
        userId: admin.id,
        permissions: [{ vehicleId: v.id, role: "ADMIN" }],
      });
      expect(res.status).toBe(400);
      expect((await parseJson<{ error: string }>(res)).error).toBe(
        "cannot_edit_own_permissions",
      );
    });

    it("400 cannot_grant_admin_to_non_admin — per-vehicle ADMIN needs global ADMIN role", async () => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const v = await createVehicle("grant-admin-v");

      const res = await putPerms(token, {
        userId: user.id,
        permissions: [{ vehicleId: v.id, role: "ADMIN" }],
      });
      expect(res.status).toBe(400);
      expect((await parseJson<{ error: string }>(res)).error).toBe(
        "cannot_grant_admin_to_non_admin",
      );

      // A user whose global role is ADMIN can receive per-vehicle ADMIN.
      const otherAdmin = await createUser({ role: Role.ADMIN });
      const okRes = await putPerms(token, {
        userId: otherAdmin.id,
        permissions: [{ vehicleId: v.id, role: "ADMIN", priorityOverride: 100 }],
      });
      expect(okRes.status).toBe(200);
    });

    it("422 on unknown fields (.strict()), duplicate vehicleIds, and unknown / archived vehicles", async () => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const v = await createVehicle("strict-v");

      const unknownField = await putPerms(token, {
        userId: user.id,
        permissions: [{ vehicleId: v.id, role: "OPERATOR", isSuper: true }],
      });
      expect(unknownField.status).toBe(422);

      const dup = await putPerms(token, {
        userId: user.id,
        permissions: [
          { vehicleId: v.id, role: "OPERATOR" },
          { vehicleId: v.id, role: "VIEWER" },
        ],
      });
      expect(dup.status).toBe(422);

      const ghost = await putPerms(token, {
        userId: user.id,
        permissions: [
          { vehicleId: "00000000-0000-4000-8000-000000000000", role: "OPERATOR" },
        ],
      });
      expect(ghost.status).toBe(422);
      expect((await parseJson<{ error: string }>(ghost)).error).toBe("unknown_vehicle");

      await prisma.vehicle.update({
        where: { id: v.id },
        data: { archivedAt: new Date() },
      });
      const archived = await putPerms(token, {
        userId: user.id,
        permissions: [{ vehicleId: v.id, role: "OPERATOR" }],
      });
      expect(archived.status).toBe(422);
      expect((await parseJson<{ error: string }>(archived)).error).toBe("unknown_vehicle");
    });

    it("leaves permissions on archived vehicles untouched by a full replace", async () => {
      const { admin, token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const live = await createVehicle("keep-live");
      const archived = await createVehicle("keep-arch");
      await createPermission(user.id, archived.id, Role.OPERATOR, admin.id);
      await prisma.vehicle.update({
        where: { id: archived.id },
        data: { archivedAt: new Date() },
      });

      const res = await putPerms(token, {
        userId: user.id,
        permissions: [{ vehicleId: live.id, role: "VIEWER" }],
      });
      expect(res.status).toBe(200);

      // The archived-vehicle permission survives even though it was absent
      // from the (non-archived-universe) replacement array.
      const row = await prisma.vehiclePermission.findUnique({
        where: { userId_vehicleId: { userId: user.id, vehicleId: archived.id } },
      });
      expect(row).not.toBeNull();
    });

    it("409 user_archived when targeting an archived user", async () => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      await prisma.user.update({
        where: { id: user.id },
        data: { archivedAt: new Date() },
      });
      const res = await putPerms(token, { userId: user.id, permissions: [] });
      expect(res.status).toBe(409);
      expect((await parseJson<{ error: string }>(res)).error).toBe("user_archived");
    });

    it("rejects non-admin callers with 403", async () => {
      const op = await createUser({ role: Role.OPERATOR });
      const token = await loginAs(op.id, op.role);
      const other = await createUser({ role: Role.VIEWER });
      const res = await putPerms(token, { userId: other.id, permissions: [] });
      expect(res.status).toBe(403);
    });
  });

  describe("PUT /admin/permissions — priorityOverride boundaries", () => {
    it.each([
      [0, 200],
      [100, 200],
      [-1, 422],
      [101, 422],
      [50.5, 422], // must be an integer
    ])("priorityOverride=%s → %s", async (value, expectedStatus) => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const v = await createVehicle(`bound-${String(value).replace(/[^0-9a-z]/gi, "n")}`);

      const res = await putPerms(token, {
        userId: user.id,
        permissions: [{ vehicleId: v.id, role: "OPERATOR", priorityOverride: value }],
      });
      expect(res.status).toBe(expectedStatus);

      if (expectedStatus === 200) {
        const row = await prisma.vehiclePermission.findUnique({
          where: { userId_vehicleId: { userId: user.id, vehicleId: v.id } },
        });
        expect(row?.priorityOverride).toBe(value);
      }
    });

    it("priorityOverride null / omitted both persist as null (role default per c14)", async () => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const v1 = await createVehicle("null-v1");
      const v2 = await createVehicle("null-v2");

      const res = await putPerms(token, {
        userId: user.id,
        permissions: [
          { vehicleId: v1.id, role: "OPERATOR", priorityOverride: null },
          { vehicleId: v2.id, role: "OPERATOR" },
        ],
      });
      expect(res.status).toBe(200);

      const rows = await prisma.vehiclePermission.findMany({
        where: { userId: user.id },
      });
      expect(rows.map((r) => r.priorityOverride)).toEqual([null, null]);
    });
  });
});
