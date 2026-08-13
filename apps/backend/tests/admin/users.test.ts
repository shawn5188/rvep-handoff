import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { Role } from "@prisma/client";
import {
  GET as LIST,
  POST as CREATE,
} from "@/app/api/v1/admin/users/route";
import {
  GET as DETAIL,
  PATCH as UPDATE,
  DELETE as ARCHIVE,
} from "@/app/api/v1/admin/users/[id]/route";
import { POST as RESET_PASSWORD } from "@/app/api/v1/admin/users/[id]/reset-password/route";
import { POST as RESEND_INVITE } from "@/app/api/v1/admin/users/[id]/resend-invite/route";
import { POST as ACCEPT_INVITE } from "@/app/api/v1/auth/accept-invite/route";
import { POST as LOGIN } from "@/app/api/v1/auth/login/route";
import { makeRequest, parseJson } from "../request-helpers";
import { createUser, createVehicle, createPermission, loginAs, bearerHeader } from "../factories";

type IdCtx = { params: Promise<{ id: string }> };
function idParams(id: string): IdCtx {
  return { params: Promise.resolve({ id }) };
}

async function adminActor() {
  const admin = await createUser({ role: Role.ADMIN });
  const token = await loginAs(admin.id, admin.role);
  return { admin, token };
}

const GOOD_PASSWORD = "CorrectHorse42Battery";

function createBody(overrides: Record<string, unknown> = {}) {
  return {
    email: `new-user-${Math.random().toString(36).slice(2)}@test.com`,
    displayName: "New User",
    role: "OPERATOR",
    inviteMethod: "manual_password",
    manualPassword: GOOD_PASSWORD,
    ...overrides,
  };
}

async function loginWith(email: string, password: string) {
  return LOGIN(
    makeRequest("/api/v1/auth/login", {
      method: "POST",
      body: { email, password },
    }),
  );
}

/** Extract the token query param from an inviteLink. */
function tokenFromLink(link: string): string {
  return new URL(link).searchParams.get("token")!;
}

describe("Admin User CRUD (c15 P4)", () => {
  describe("POST /admin/users — manual_password flow", () => {
    it("creates the user, echoes temporaryPassword, audits, and the user can log in", async () => {
      const { admin, token } = await adminActor();
      const body = createBody();

      const res = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body,
        }),
        undefined,
      );
      const json = await parseJson<{ data: Record<string, unknown> }>(res);

      expect(res.status).toBe(201);
      expect(json.data.email).toBe(body.email);
      expect(json.data.role).toBe("OPERATOR");
      expect(json.data.invitePending).toBe(false);
      expect(json.data.temporaryPassword).toBe(GOOD_PASSWORD);
      expect(json.data.inviteLink).toBeUndefined();
      // No secrets on the wire.
      expect(json.data.passwordHash).toBeUndefined();
      expect(json.data.twoFactorSecret).toBeUndefined();
      expect(json.data.inviteToken).toBeUndefined();

      const event = await prisma.eventLog.findFirst({
        where: { eventName: "user_created", actorId: admin.id },
      });
      expect(event).not.toBeNull();
      expect(event?.payload).toMatchObject({
        email: body.email,
        role: "OPERATOR",
        inviteMethod: "manual_password",
      });

      const login = await loginWith(body.email as string, GOOD_PASSWORD);
      expect(login.status).toBe(200);
    });

    it("flags admin_role_granted warning when creating another ADMIN", async () => {
      const { token } = await adminActor();
      const res = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body: createBody({ role: "ADMIN" }),
        }),
        undefined,
      );
      const json = await parseJson<{ data: { warning?: string } }>(res);
      expect(res.status).toBe(201);
      expect(json.data.warning).toBe("admin_role_granted");
    });

    it("copies permissions from another user via copyPermissionsFromUserId", async () => {
      const { admin, token } = await adminActor();
      const source = await createUser({ role: Role.OPERATOR });
      const vehicle = await createVehicle("perm-copy");
      await createPermission(source.id, vehicle.id, Role.OPERATOR, admin.id);

      const res = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body: createBody({ copyPermissionsFromUserId: source.id }),
        }),
        undefined,
      );
      const json = await parseJson<{ data: { id: string; activePermissionCount: number } }>(res);
      expect(res.status).toBe(201);
      expect(json.data.activePermissionCount).toBe(1);

      const perms = await prisma.vehiclePermission.findMany({
        where: { userId: json.data.id },
      });
      expect(perms).toHaveLength(1);
      expect(perms[0].vehicleId).toBe(vehicle.id);
      expect(perms[0].grantedBy).toBe(admin.id);
    });
  });

  describe("POST /admin/users — password policy", () => {
    it.each([
      ["too short", "Short1", "too_short"],
      ["no digit", "OnlyLettersHere", "missing_digit"],
      ["no letter", "123456789012", "missing_letter"],
      ["common password", "password12345", "common_password"],
    ])("rejects weak password (%s) with 422", async (_label, pw, reason) => {
      const { token } = await adminActor();
      const res = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body: createBody({ manualPassword: pw }),
        }),
        undefined,
      );
      const json = await parseJson<{ error: string; reason?: string }>(res);
      expect(res.status).toBe(422);
      expect(json.error).toBe("weak_password");
      expect(json.reason).toBe(reason);
    });

    it("accepts a 12+ char password with letters and digits", async () => {
      const { token } = await adminActor();
      const res = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body: createBody({ manualPassword: "aVeryLong12Password" }),
        }),
        undefined,
      );
      expect(res.status).toBe(201);
    });
  });

  describe("POST /admin/users — invite flow", () => {
    it("creates a pending user with 72h inviteLink; accept-invite then login works", async () => {
      const { token } = await adminActor();
      const body = createBody({ inviteMethod: "email", manualPassword: undefined });

      const before = Date.now();
      const res = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body,
        }),
        undefined,
      );
      const json = await parseJson<{
        data: { id: string; invitePending: boolean; inviteLink: string; inviteExpiresAt: string };
      }>(res);

      expect(res.status).toBe(201);
      expect(json.data.invitePending).toBe(true);
      expect(json.data.inviteLink).toContain("/accept-invite?token=");
      const ttl = new Date(json.data.inviteExpiresAt).getTime() - before;
      expect(ttl).toBeGreaterThan(71 * 3600 * 1000);
      expect(ttl).toBeLessThan(73 * 3600 * 1000);

      // User cannot log in before accepting (placeholder hash).
      const early = await loginWith(body.email as string, GOOD_PASSWORD);
      expect(early.status).toBe(401);

      const accept = await ACCEPT_INVITE(
        makeRequest("/api/v1/auth/accept-invite", {
          method: "POST",
          body: {
            inviteToken: tokenFromLink(json.data.inviteLink),
            newPassword: GOOD_PASSWORD,
          },
        }),
      );
      expect(accept.status).toBe(200);

      const row = await prisma.user.findUnique({ where: { id: json.data.id } });
      expect(row?.invitePending).toBe(false);
      expect(row?.inviteToken).toBeNull();

      const acceptedEvent = await prisma.eventLog.findFirst({
        where: { eventName: "user_invite_accepted", actorId: json.data.id },
      });
      expect(acceptedEvent?.targetId).toBe(json.data.id);

      const login = await loginWith(body.email as string, GOOD_PASSWORD);
      expect(login.status).toBe(200);
    });

    it("accept-invite rejects unknown, reused, and expired tokens", async () => {
      const { token } = await adminActor();
      const res = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body: createBody({ inviteMethod: "email", manualPassword: undefined }),
        }),
        undefined,
      );
      const json = await parseJson<{ data: { id: string; inviteLink: string } }>(res);
      const inviteToken = tokenFromLink(json.data.inviteLink);

      const unknown = await ACCEPT_INVITE(
        makeRequest("/api/v1/auth/accept-invite", {
          method: "POST",
          body: { inviteToken: "a".repeat(43), newPassword: GOOD_PASSWORD },
        }),
      );
      expect(unknown.status).toBe(400);
      expect((await parseJson<{ error: string }>(unknown)).error).toBe("invalid_invite_token");

      // Expired token.
      await prisma.user.update({
        where: { id: json.data.id },
        data: { inviteExpiresAt: new Date(Date.now() - 1000) },
      });
      const expired = await ACCEPT_INVITE(
        makeRequest("/api/v1/auth/accept-invite", {
          method: "POST",
          body: { inviteToken, newPassword: GOOD_PASSWORD },
        }),
      );
      expect(expired.status).toBe(400);
      expect((await parseJson<{ error: string }>(expired)).error).toBe("invite_expired");

      // Un-expire, accept once, then the token must be consumed.
      await prisma.user.update({
        where: { id: json.data.id },
        data: { inviteExpiresAt: new Date(Date.now() + 3600_000) },
      });
      const first = await ACCEPT_INVITE(
        makeRequest("/api/v1/auth/accept-invite", {
          method: "POST",
          body: { inviteToken, newPassword: GOOD_PASSWORD },
        }),
      );
      expect(first.status).toBe(200);
      const reused = await ACCEPT_INVITE(
        makeRequest("/api/v1/auth/accept-invite", {
          method: "POST",
          body: { inviteToken, newPassword: GOOD_PASSWORD },
        }),
      );
      expect(reused.status).toBe(400);
    });

    it("accept-invite enforces the password policy (422 weak_password)", async () => {
      const { token } = await adminActor();
      const res = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body: createBody({ inviteMethod: "email", manualPassword: undefined }),
        }),
        undefined,
      );
      const json = await parseJson<{ data: { inviteLink: string } }>(res);

      const weak = await ACCEPT_INVITE(
        makeRequest("/api/v1/auth/accept-invite", {
          method: "POST",
          body: { inviteToken: tokenFromLink(json.data.inviteLink), newPassword: "weak1" },
        }),
      );
      expect(weak.status).toBe(422);
      expect((await parseJson<{ error: string }>(weak)).error).toBe("weak_password");
    });
  });

  describe("POST /admin/users — guards", () => {
    it("returns 409 email_taken on duplicate email", async () => {
      const { token } = await adminActor();
      const body = createBody();
      const first = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body,
        }),
        undefined,
      );
      expect(first.status).toBe(201);

      const dup = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body,
        }),
        undefined,
      );
      expect(dup.status).toBe(409);
      expect((await parseJson<{ error: string }>(dup)).error).toBe("email_taken");
    });

    it("rejects non-admin callers with 403", async () => {
      const op = await createUser({ role: Role.OPERATOR });
      const token = await loginAs(op.id, op.role);
      const res = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body: createBody(),
        }),
        undefined,
      );
      expect(res.status).toBe(403);
    });

    it("rejects unknown fields with 422 (strict schema)", async () => {
      const { token } = await adminActor();
      const res = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body: createBody({ isSuperuser: true }),
        }),
        undefined,
      );
      expect(res.status).toBe(422);
    });

    it("requires manualPassword when inviteMethod=manual_password", async () => {
      const { token } = await adminActor();
      const res = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body: createBody({ manualPassword: undefined }),
        }),
        undefined,
      );
      expect(res.status).toBe(422);
    });
  });

  describe("GET /admin/users", () => {
    it("hides archived users unless includeArchived=1, filters by role, includes stats", async () => {
      const { admin, token } = await adminActor();
      const operator = await createUser({ role: Role.OPERATOR });
      const archived = await createUser({ role: Role.VIEWER });
      await prisma.user.update({
        where: { id: archived.id },
        data: { archivedAt: new Date() },
      });
      const vehicle = await createVehicle("list-stats");
      await createPermission(operator.id, vehicle.id, Role.OPERATOR, admin.id);

      const res = await LIST(
        makeRequest("/api/v1/admin/users", { headers: bearerHeader(token) }),
        undefined,
      );
      const json = await parseJson<{
        data: Array<{ id: string; activePermissionCount: number; lastLoginAt: string | null }>;
      }>(res);
      expect(res.status).toBe(200);
      const ids = json.data.map((u) => u.id);
      expect(ids).toContain(operator.id);
      expect(ids).not.toContain(archived.id);
      const opRow = json.data.find((u) => u.id === operator.id)!;
      expect(opRow.activePermissionCount).toBe(1);
      expect(opRow.lastLoginAt).toBeNull();

      const all = await LIST(
        makeRequest("/api/v1/admin/users?includeArchived=1", {
          headers: bearerHeader(token),
        }),
        undefined,
      );
      const allJson = await parseJson<{ data: Array<{ id: string }> }>(all);
      expect(allJson.data.map((u) => u.id)).toContain(archived.id);

      const admins = await LIST(
        makeRequest("/api/v1/admin/users?role=ADMIN", { headers: bearerHeader(token) }),
        undefined,
      );
      const adminsJson = await parseJson<{ data: Array<{ role: string }> }>(admins);
      expect(adminsJson.data.length).toBeGreaterThan(0);
      expect(adminsJson.data.every((u) => u.role === "ADMIN")).toBe(true);
    });

    it("surfaces lastLoginAt after a successful login", async () => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.VIEWER, password: GOOD_PASSWORD });
      const login = await loginWith(user.email, GOOD_PASSWORD);
      expect(login.status).toBe(200);

      const res = await LIST(
        makeRequest("/api/v1/admin/users", { headers: bearerHeader(token) }),
        undefined,
      );
      const json = await parseJson<{ data: Array<{ id: string; lastLoginAt: string | null }> }>(res);
      expect(json.data.find((u) => u.id === user.id)?.lastLoginAt).not.toBeNull();
    });
  });

  describe("GET /admin/users/:id", () => {
    it("returns detail with permissions summary + recent audit events", async () => {
      const { admin, token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const vehicle = await createVehicle("detail-perm");
      await createPermission(user.id, vehicle.id, Role.OPERATOR, admin.id);
      // A row where the user is the actor.
      await prisma.eventLog.create({
        data: { eventName: "login_success", userId: user.id, actorId: user.id },
      });

      const res = await DETAIL(
        makeRequest(`/api/v1/admin/users/${user.id}`, { headers: bearerHeader(token) }),
        idParams(user.id),
      );
      const json = await parseJson<{
        data: {
          permissions: Array<{ vehicleId: string; role: string }>;
          recentAuditEvents: Array<{ eventName: string }>;
          lastLoginAt: string | null;
        };
      }>(res);

      expect(res.status).toBe(200);
      expect(json.data.permissions).toHaveLength(1);
      expect(json.data.permissions[0].vehicleId).toBe(vehicle.vehicleId);
      expect(json.data.recentAuditEvents.some((e) => e.eventName === "login_success")).toBe(true);
      expect(json.data.lastLoginAt).not.toBeNull();
    });

    it("unknown id → 404", async () => {
      const { token } = await adminActor();
      const res = await DETAIL(
        makeRequest("/api/v1/admin/users/00000000-0000-4000-8000-000000000000", {
          headers: bearerHeader(token),
        }),
        idParams("00000000-0000-4000-8000-000000000000"),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /admin/users/:id", () => {
    it("changes role + email with dedicated audit events", async () => {
      const { admin, token } = await adminActor();
      const user = await createUser({ role: Role.VIEWER });

      const res = await UPDATE(
        makeRequest(`/api/v1/admin/users/${user.id}`, {
          method: "PATCH",
          headers: bearerHeader(token),
          body: { role: "OPERATOR", email: "renamed@test.com" },
        }),
        idParams(user.id),
      );
      const json = await parseJson<{ data: { role: string; email: string } }>(res);
      expect(res.status).toBe(200);
      expect(json.data.role).toBe("OPERATOR");
      expect(json.data.email).toBe("renamed@test.com");

      const roleEvent = await prisma.eventLog.findFirst({
        where: { eventName: "user_role_changed", actorId: admin.id },
      });
      expect(roleEvent?.payload).toMatchObject({ from: "VIEWER", to: "OPERATOR" });

      const emailEvent = await prisma.eventLog.findFirst({
        where: { eventName: "user_email_changed", actorId: admin.id },
      });
      expect(emailEvent?.payload).toMatchObject({ to: "renamed@test.com" });
    });

    it("rejects immutable / unknown fields with 422 and duplicate email with 409", async () => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.VIEWER });
      const other = await createUser({ role: Role.VIEWER });

      const immutable = await UPDATE(
        makeRequest(`/api/v1/admin/users/${user.id}`, {
          method: "PATCH",
          headers: bearerHeader(token),
          body: { passwordHash: "hacked" },
        }),
        idParams(user.id),
      );
      expect(immutable.status).toBe(422);

      const dup = await UPDATE(
        makeRequest(`/api/v1/admin/users/${user.id}`, {
          method: "PATCH",
          headers: bearerHeader(token),
          body: { email: other.email },
        }),
        idParams(user.id),
      );
      expect(dup.status).toBe(409);
    });

    it("blocks demoting the last active ADMIN (400 last_admin_protected)", async () => {
      const { admin, token } = await adminActor(); // the only admin
      const res = await UPDATE(
        makeRequest(`/api/v1/admin/users/${admin.id}`, {
          method: "PATCH",
          headers: bearerHeader(token),
          body: { role: "OPERATOR" },
        }),
        idParams(admin.id),
      );
      expect(res.status).toBe(400);
      expect((await parseJson<{ error: string }>(res)).error).toBe("last_admin_protected");
    });

    it("restores an archived user via archivedAt=null", async () => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.VIEWER });
      await prisma.user.update({
        where: { id: user.id },
        data: { archivedAt: new Date() },
      });

      const res = await UPDATE(
        makeRequest(`/api/v1/admin/users/${user.id}`, {
          method: "PATCH",
          headers: bearerHeader(token),
          body: { archivedAt: null },
        }),
        idParams(user.id),
      );
      const json = await parseJson<{ data: { archivedAt: string | null } }>(res);
      expect(res.status).toBe(200);
      expect(json.data.archivedAt).toBeNull();
    });
  });

  describe("DELETE /admin/users/:id", () => {
    it("soft-archives, bumps refreshTokenVersion, audits; double archive → 409", async () => {
      const { admin, token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const versionBefore = user.refreshTokenVersion;

      const res = await ARCHIVE(
        makeRequest(`/api/v1/admin/users/${user.id}`, {
          method: "DELETE",
          headers: bearerHeader(token),
        }),
        idParams(user.id),
      );
      const json = await parseJson<{ data: { archivedAt: string | null } }>(res);
      expect(res.status).toBe(200);
      expect(json.data.archivedAt).not.toBeNull();

      const row = await prisma.user.findUnique({ where: { id: user.id } });
      expect(row?.archivedAt).not.toBeNull();
      expect(row?.refreshTokenVersion).toBe(versionBefore + 1);

      const event = await prisma.eventLog.findFirst({
        where: { eventName: "user_archived", actorId: admin.id },
      });
      expect(event?.targetId).toBe(user.id);

      const again = await ARCHIVE(
        makeRequest(`/api/v1/admin/users/${user.id}`, {
          method: "DELETE",
          headers: bearerHeader(token),
        }),
        idParams(user.id),
      );
      expect(again.status).toBe(409);
    });

    it("archived user can no longer log in", async () => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR, password: GOOD_PASSWORD });

      await ARCHIVE(
        makeRequest(`/api/v1/admin/users/${user.id}`, {
          method: "DELETE",
          headers: bearerHeader(token),
        }),
        idParams(user.id),
      );

      const login = await loginWith(user.email, GOOD_PASSWORD);
      expect(login.status).toBe(401);
    });

    it("blocks archiving yourself (400 cannot_archive_self)", async () => {
      const { admin, token } = await adminActor();
      const res = await ARCHIVE(
        makeRequest(`/api/v1/admin/users/${admin.id}`, {
          method: "DELETE",
          headers: bearerHeader(token),
        }),
        idParams(admin.id),
      );
      expect(res.status).toBe(400);
      expect((await parseJson<{ error: string }>(res)).error).toBe("cannot_archive_self");
    });

    it("blocks archiving the last active ADMIN (400 last_admin_protected)", async () => {
      // Admin A archives admin B, then A (already archived themselves via B?
      // no —) A is archived by B; A's still-valid JWT then tries to archive B,
      // who is now the last active admin.
      const a = await createUser({ role: Role.ADMIN });
      const b = await createUser({ role: Role.ADMIN });
      const tokenB = await loginAs(b.id, b.role);
      const tokenA = await loginAs(a.id, a.role);

      const archiveA = await ARCHIVE(
        makeRequest(`/api/v1/admin/users/${a.id}`, {
          method: "DELETE",
          headers: bearerHeader(tokenB),
        }),
        idParams(a.id),
      );
      expect(archiveA.status).toBe(200);

      const res = await ARCHIVE(
        makeRequest(`/api/v1/admin/users/${b.id}`, {
          method: "DELETE",
          headers: bearerHeader(tokenA),
        }),
        idParams(b.id),
      );
      expect(res.status).toBe(400);
      expect((await parseJson<{ error: string }>(res)).error).toBe("last_admin_protected");
    });
  });

  describe("POST /admin/users/:id/reset-password", () => {
    it("manual: sets a new password, bumps refreshTokenVersion, audits; login works", async () => {
      const { admin, token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR, password: "OldPassword99x" });
      const versionBefore = user.refreshTokenVersion;
      const newPassword = "BrandNew42Password";

      const res = await RESET_PASSWORD(
        makeRequest(`/api/v1/admin/users/${user.id}/reset-password`, {
          method: "POST",
          headers: bearerHeader(token),
          body: { method: "manual", manualPassword: newPassword },
        }),
        idParams(user.id),
      );
      const json = await parseJson<{ data: { temporaryPassword: string } }>(res);
      expect(res.status).toBe(200);
      expect(json.data.temporaryPassword).toBe(newPassword);

      const row = await prisma.user.findUnique({ where: { id: user.id } });
      expect(row?.refreshTokenVersion).toBe(versionBefore + 1);

      const event = await prisma.eventLog.findFirst({
        where: { eventName: "user_password_reset", actorId: admin.id },
      });
      expect(event?.payload).toMatchObject({ method: "manual" });

      expect((await loginWith(user.email, "OldPassword99x")).status).toBe(401);
      expect((await loginWith(user.email, newPassword)).status).toBe(200);
    });

    it("manual: rejects weak password with 422", async () => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const res = await RESET_PASSWORD(
        makeRequest(`/api/v1/admin/users/${user.id}/reset-password`, {
          method: "POST",
          headers: bearerHeader(token),
          body: { method: "manual", manualPassword: "short1" },
        }),
        idParams(user.id),
      );
      expect(res.status).toBe(422);
      expect((await parseJson<{ error: string }>(res)).error).toBe("weak_password");
    });

    it("invite_link: re-issues a token, marks pending, bumps version; accept works", async () => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const versionBefore = user.refreshTokenVersion;

      const res = await RESET_PASSWORD(
        makeRequest(`/api/v1/admin/users/${user.id}/reset-password`, {
          method: "POST",
          headers: bearerHeader(token),
          body: { method: "invite_link" },
        }),
        idParams(user.id),
      );
      const json = await parseJson<{ data: { inviteLink: string } }>(res);
      expect(res.status).toBe(200);
      expect(json.data.inviteLink).toContain("/accept-invite?token=");

      const row = await prisma.user.findUnique({ where: { id: user.id } });
      expect(row?.invitePending).toBe(true);
      expect(row?.refreshTokenVersion).toBe(versionBefore + 1);

      const accept = await ACCEPT_INVITE(
        makeRequest("/api/v1/auth/accept-invite", {
          method: "POST",
          body: {
            inviteToken: tokenFromLink(json.data.inviteLink),
            newPassword: GOOD_PASSWORD,
          },
        }),
      );
      expect(accept.status).toBe(200);
      expect((await loginWith(user.email, GOOD_PASSWORD)).status).toBe(200);
    });
  });

  describe("POST /admin/users/:id/resend-invite", () => {
    it("re-signs the token for a pending user and audits", async () => {
      const { admin, token } = await adminActor();
      const create = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body: createBody({ inviteMethod: "email", manualPassword: undefined }),
        }),
        undefined,
      );
      const created = await parseJson<{ data: { id: string; inviteLink: string } }>(create);
      const oldToken = tokenFromLink(created.data.inviteLink);

      const res = await RESEND_INVITE(
        makeRequest(`/api/v1/admin/users/${created.data.id}/resend-invite`, {
          method: "POST",
          headers: bearerHeader(token),
        }),
        idParams(created.data.id),
      );
      const json = await parseJson<{ data: { inviteLink: string } }>(res);
      expect(res.status).toBe(200);
      const newToken = tokenFromLink(json.data.inviteLink);
      expect(newToken).not.toBe(oldToken);

      const event = await prisma.eventLog.findFirst({
        where: { eventName: "user_invite_resent", actorId: admin.id },
      });
      expect(event?.targetId).toBe(created.data.id);

      // The old token is dead; the new one works.
      const oldAccept = await ACCEPT_INVITE(
        makeRequest("/api/v1/auth/accept-invite", {
          method: "POST",
          body: { inviteToken: oldToken, newPassword: GOOD_PASSWORD },
        }),
      );
      expect(oldAccept.status).toBe(400);
      const newAccept = await ACCEPT_INVITE(
        makeRequest("/api/v1/auth/accept-invite", {
          method: "POST",
          body: { inviteToken: newToken, newPassword: GOOD_PASSWORD },
        }),
      );
      expect(newAccept.status).toBe(200);
    });

    it("returns 409 invite_not_pending for a non-pending user", async () => {
      const { token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      const res = await RESEND_INVITE(
        makeRequest(`/api/v1/admin/users/${user.id}/resend-invite`, {
          method: "POST",
          headers: bearerHeader(token),
        }),
        idParams(user.id),
      );
      expect(res.status).toBe(409);
      expect((await parseJson<{ error: string }>(res)).error).toBe("invite_not_pending");
    });
  });

  describe("audit completeness", () => {
    it("writes user_created / user_role_changed / user_password_reset / user_invite_accepted", async () => {
      const { token } = await adminActor();

      // create (invite flow)
      const create = await CREATE(
        makeRequest("/api/v1/admin/users", {
          method: "POST",
          headers: bearerHeader(token),
          body: createBody({ inviteMethod: "email", manualPassword: undefined }),
        }),
        undefined,
      );
      const created = await parseJson<{ data: { id: string; inviteLink: string } }>(create);

      // accept invite
      await ACCEPT_INVITE(
        makeRequest("/api/v1/auth/accept-invite", {
          method: "POST",
          body: {
            inviteToken: tokenFromLink(created.data.inviteLink),
            newPassword: GOOD_PASSWORD,
          },
        }),
      );

      // role change
      await UPDATE(
        makeRequest(`/api/v1/admin/users/${created.data.id}`, {
          method: "PATCH",
          headers: bearerHeader(token),
          body: { role: "VIEWER" },
        }),
        idParams(created.data.id),
      );

      // password reset
      await RESET_PASSWORD(
        makeRequest(`/api/v1/admin/users/${created.data.id}/reset-password`, {
          method: "POST",
          headers: bearerHeader(token),
          body: { method: "manual", manualPassword: "AnotherPass42x" },
        }),
        idParams(created.data.id),
      );

      for (const eventName of [
        "user_created",
        "user_invite_accepted",
        "user_role_changed",
        "user_password_reset",
      ]) {
        const count = await prisma.eventLog.count({
          where: { eventName, targetId: created.data.id },
        });
        expect(count, eventName).toBe(1);
      }
    });
  });
});
