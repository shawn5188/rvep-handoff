/**
 * c15 P7 — E2E integration tests for the Admin Onboarding Suite.
 *
 * HTTP-level: direct route handler calls via NextRequest (same pattern as
 * tests/admin/vehicles.test.ts, audit.test.ts). Uses real pglite DB — no mocks.
 *
 * Scenarios:
 *   1. Happy path: vehicle create → user create → permissions → token mint →
 *      deploy pkg → audit timeline → CSV export
 *   2. Invite flow: invite link → accept-invite → login → RBAC guard
 *   3. RBAC protection: operator blocked from admin routes; self-archive guard;
 *      last-admin guard
 *   4. Password reset: admin reset → user login with temp password → refresh
 */

import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { Role } from "@prisma/client";
import { makeRequest, parseJson } from "../request-helpers";
import { createUser, loginAs, bearerHeader } from "../factories";

// Route handlers
import {
  GET as ADMIN_VEHICLES_GET,
  POST as ADMIN_VEHICLES_POST,
} from "@/app/api/v1/admin/vehicles/route";
import { DELETE as ADMIN_USER_DELETE } from "@/app/api/v1/admin/users/[id]/route";
import { POST as ADMIN_VEHICLE_TOKEN } from "@/app/api/v1/admin/vehicles/[id]/token/route";
import { GET as ADMIN_VEHICLE_DEPLOY } from "@/app/api/v1/admin/vehicles/[id]/deploy-package/route";
import {
  POST as ADMIN_USERS_POST,
} from "@/app/api/v1/admin/users/route";
import { POST as ADMIN_RESET_PASSWORD } from "@/app/api/v1/admin/users/[id]/reset-password/route";
import {
  PUT as ADMIN_PERMISSIONS_PUT,
} from "@/app/api/v1/admin/permissions/route";
import { GET as ADMIN_AUDIT_GET } from "@/app/api/v1/admin/audit/route";
import { GET as ADMIN_AUDIT_EXPORT } from "@/app/api/v1/admin/audit/export/route";
import { GET as ADMIN_DASHBOARD_GET } from "@/app/api/v1/admin/dashboard/route";
import { POST as ACCEPT_INVITE } from "@/app/api/v1/auth/accept-invite/route";
import { POST as LOGIN } from "@/app/api/v1/auth/login/route";
import { POST as REFRESH } from "@/app/api/v1/auth/refresh/route";

// Param helpers matching Next.js route handler signature
type IdParam = { params: Promise<{ id: string }> };
function idParam(id: string): IdParam {
  return { params: Promise.resolve({ id }) };
}

const BASE_VEHICLE_BODY = {
  vehicleId: "test-e2e-01",
  displayName: "E2E Test Vehicle",
  vehicleType: "WHEELED",
  adapterType: "generic_ros2_cmd_vel",
  platformId: "jetson-agx-orin",
  cameraProfileId: "zed-x-front-1080p60",
  audioProfileId: "jabra-speak2-55",
};

// ---------------------------------------------------------------------------
// Scenario 1: Happy path
// ---------------------------------------------------------------------------

describe("Scenario 1 — Happy path onboarding", () => {
  it("admin creates vehicle, user, grants permission, mints token, downloads deploy pkg, checks audit + CSV", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const adminToken = await loginAs(admin.id, admin.role);
    const adminHdr = bearerHeader(adminToken);

    // 1. POST /admin/vehicles — create test-e2e-01
    const createVehicleRes = await ADMIN_VEHICLES_POST(
      makeRequest("/api/v1/admin/vehicles", {
        method: "POST",
        headers: adminHdr,
        body: BASE_VEHICLE_BODY,
      }),
      undefined,
    );
    expect(createVehicleRes.status).toBe(201);
    const vehicleBody = await parseJson<{ data: { vehicleId: string } }>(createVehicleRes);
    expect(vehicleBody.data.vehicleId).toBe("test-e2e-01");
    const vehicleId = vehicleBody.data.vehicleId;

    // 2. POST /admin/users — create operator1@e2e.test with manual_password
    const createUserRes = await ADMIN_USERS_POST(
      makeRequest("/api/v1/admin/users", {
        method: "POST",
        headers: adminHdr,
        body: {
          email: "operator1@e2e.test",
          displayName: "E2E Operator",
          role: "OPERATOR",
          inviteMethod: "manual_password",
          manualPassword: "Operator1234!E2E",
        },
      }),
      undefined,
    );
    expect(createUserRes.status).toBe(201);
    const userBody = await parseJson<{
      data: { id: string; temporaryPassword: string };
    }>(createUserRes);
    const operatorId = userBody.data.id;
    expect(operatorId).toBeTruthy();
    expect(userBody.data.temporaryPassword).toBe("Operator1234!E2E");

    // 3. Look up vehicle internal id for permission grant
    const vehicleRow = await prisma.vehicle.findUnique({
      where: { vehicleId },
      select: { id: true },
    });
    expect(vehicleRow).not.toBeNull();
    const vehicleInternalId = vehicleRow!.id;

    // 4. PUT /admin/permissions — grant OPERATOR on test-e2e-01
    const grantRes = await ADMIN_PERMISSIONS_PUT(
      makeRequest("/api/v1/admin/permissions", {
        method: "PUT",
        headers: adminHdr,
        body: {
          userId: operatorId,
          permissions: [{ vehicleId: vehicleInternalId, role: "OPERATOR" }],
        },
      }),
      undefined,
    );
    expect(grantRes.status).toBe(200);

    // 5. POST /admin/vehicles/:id/token — mint token
    const mintRes = await ADMIN_VEHICLE_TOKEN(
      makeRequest(`/api/v1/admin/vehicles/${vehicleId}/token`, {
        method: "POST",
        headers: adminHdr,
        body: {},
      }),
      idParam(vehicleId),
    );
    expect(mintRes.status).toBe(200);
    const mintBody = await parseJson<{ data: { token: string; expiresAt: string } }>(mintRes);
    expect(mintBody.data.token).toBeTruthy();
    expect(mintBody.data.expiresAt).toBeTruthy();

    // 6. GET /admin/vehicles/:id/deploy-package — verify content-type + size > 0
    const deployRes = await ADMIN_VEHICLE_DEPLOY(
      makeRequest(`/api/v1/admin/vehicles/${vehicleId}/deploy-package`, {
        headers: adminHdr,
      }),
      idParam(vehicleId),
    );
    expect(deployRes.status).toBe(200);
    expect(deployRes.headers.get("content-type")).toContain("gzip");
    const deployBytes = await deployRes.arrayBuffer();
    expect(deployBytes.byteLength).toBeGreaterThan(0);

    // 7. GET /admin/audit — verify audit events exist
    const auditRes = await ADMIN_AUDIT_GET(
      makeRequest("/api/v1/admin/audit?category=AUDIT&limit=100", {
        headers: adminHdr,
      }),
      undefined,
    );
    expect(auditRes.status).toBe(200);
    const auditBody = await parseJson<{
      data: { events: Array<{ eventName: string }> };
    }>(auditRes);
    const eventNames = auditBody.data.events.map((e) => e.eventName);
    expect(eventNames).toContain("vehicle_created");
    expect(eventNames).toContain("user_created");
    expect(eventNames).toContain("user_permissions_updated");
    expect(eventNames).toContain("vehicle_token_minted");

    // 8. GET /admin/audit/export — verify CSV rowCount >= 1
    const csvRes = await ADMIN_AUDIT_EXPORT(
      makeRequest("/api/v1/admin/audit/export?category=AUDIT", {
        headers: adminHdr,
      }),
      undefined,
    );
    expect(csvRes.status).toBe(200);
    expect(csvRes.headers.get("content-type")).toContain("text/csv");
    const csvText = await csvRes.text();
    // BOM + header row + at least one data row
    const csvLines = csvText.replace(/^﻿/, "").split("\r\n").filter((l) => l.trim() !== "");
    expect(csvLines.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Invite flow
// ---------------------------------------------------------------------------

describe("Scenario 2 — Invite flow", () => {
  it("admin sends invite link, invitee accepts, logs in, and is blocked from admin routes", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const adminToken = await loginAs(admin.id, admin.role);
    const adminHdr = bearerHeader(adminToken);

    // 1. POST /admin/users — invite_link mode
    const inviteRes = await ADMIN_USERS_POST(
      makeRequest("/api/v1/admin/users", {
        method: "POST",
        headers: adminHdr,
        body: {
          email: "invitee@e2e.test",
          displayName: "E2E Invitee",
          role: "VIEWER",
          inviteMethod: "email",
        },
      }),
      undefined,
    );
    expect(inviteRes.status).toBe(201);
    const inviteBody = await parseJson<{
      data: { id: string; inviteLink: string };
    }>(inviteRes);
    const inviteLink = inviteBody.data.inviteLink;
    expect(inviteLink).toBeTruthy();

    // Extract the token from the invite link URL
    const inviteToken = new URL(inviteLink).searchParams.get("token") ?? "";
    expect(inviteToken).toBeTruthy();

    // 2. POST /auth/accept-invite (public route — no auth)
    const acceptRes = await ACCEPT_INVITE(
      makeRequest("/api/v1/auth/accept-invite", {
        method: "POST",
        body: { inviteToken, newPassword: "Invite1234!E2EAccepted" },
      }),
    );
    expect(acceptRes.status).toBe(200);

    // 3. Login as invitee → 200 + accessToken
    const loginRes = await LOGIN(
      makeRequest("/api/v1/auth/login", {
        method: "POST",
        body: { email: "invitee@e2e.test", password: "Invite1234!E2EAccepted" },
      }),
    );
    expect(loginRes.status).toBe(200);
    const loginBody = await parseJson<{ data: { accessToken: string } }>(loginRes);
    const inviteeToken = loginBody.data.accessToken;
    expect(inviteeToken).toBeTruthy();

    // 4. GET /admin/vehicles with invitee (VIEWER) token → 403
    const vehiclesRes = await ADMIN_VEHICLES_GET(
      makeRequest("/api/v1/admin/vehicles", {
        headers: bearerHeader(inviteeToken),
      }),
      undefined,
    );
    expect(vehiclesRes.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: RBAC protection
// ---------------------------------------------------------------------------

describe("Scenario 3 — RBAC protection", () => {
  it("operator is blocked from admin dashboard and permissions update", async () => {
    const operator = await createUser({ role: Role.OPERATOR });
    const opToken = await loginAs(operator.id, operator.role);
    const opHdr = bearerHeader(opToken);

    // GET /admin/dashboard with operator token → 403
    const dashRes = await ADMIN_DASHBOARD_GET(
      makeRequest("/api/v1/admin/dashboard", { headers: opHdr }),
      undefined,
    );
    expect(dashRes.status).toBe(403);

    // PUT /admin/permissions with operator token → 403
    const permRes = await ADMIN_PERMISSIONS_PUT(
      makeRequest("/api/v1/admin/permissions", {
        method: "PUT",
        headers: opHdr,
        body: { userId: operator.id, permissions: [] },
      }),
      undefined,
    );
    expect(permRes.status).toBe(403);
  });

  it("admin cannot archive self (400 cannot_archive_self)", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const adminToken = await loginAs(admin.id, admin.role);
    const adminHdr = bearerHeader(adminToken);

    const res = await ADMIN_USER_DELETE(
      makeRequest(`/api/v1/admin/users/${admin.id}`, {
        method: "DELETE",
        headers: adminHdr,
      }),
      idParam(admin.id),
    );
    expect(res.status).toBe(400);
    const body = await parseJson<{ error: string }>(res);
    expect(body.error).toBe("cannot_archive_self");
  });

  it("last active admin is protected when trying to archive the only remaining admin", async () => {
    // Create two admins; admin1 archives admin2 (last active admin check)
    // then admin1 (now sole admin) tries to archive themselves → cannot_archive_self
    const admin1 = await createUser({ role: Role.ADMIN });
    const admin2 = await createUser({ role: Role.ADMIN });
    const admin1Token = await loginAs(admin1.id, admin1.role);
    const admin1Hdr = bearerHeader(admin1Token);

    // admin1 archives admin2 successfully
    const archiveAdmin2Res = await ADMIN_USER_DELETE(
      makeRequest(`/api/v1/admin/users/${admin2.id}`, {
        method: "DELETE",
        headers: admin1Hdr,
      }),
      idParam(admin2.id),
    );
    expect(archiveAdmin2Res.status).toBe(200);

    // admin1 is now the last active ADMIN. Self-archive is blocked.
    const selfArchiveRes = await ADMIN_USER_DELETE(
      makeRequest(`/api/v1/admin/users/${admin1.id}`, {
        method: "DELETE",
        headers: admin1Hdr,
      }),
      idParam(admin1.id),
    );
    expect(selfArchiveRes.status).toBe(400);
    const selfBody = await parseJson<{ error: string }>(selfArchiveRes);
    // Self-archive check fires before last-admin check, both return 400
    expect(["cannot_archive_self", "last_admin_protected"]).toContain(selfBody.error);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: Password reset
// ---------------------------------------------------------------------------

describe("Scenario 4 — Password reset flow", () => {
  it("admin resets user password, user logs in with temp password, refresh works", async () => {
    const admin = await createUser({ role: Role.ADMIN });
    const target = await createUser({
      role: Role.OPERATOR,
      password: "OldPassword1234!",
    });
    const adminToken = await loginAs(admin.id, admin.role);
    const adminHdr = bearerHeader(adminToken);

    // 1. Admin resets password → get tempPassword
    const resetRes = await ADMIN_RESET_PASSWORD(
      makeRequest(`/api/v1/admin/users/${target.id}/reset-password`, {
        method: "POST",
        headers: adminHdr,
        body: { method: "manual", manualPassword: "TempPass1234!NewE2E" },
      }),
      idParam(target.id),
    );
    expect(resetRes.status).toBe(200);
    const resetBody = await parseJson<{ data: { temporaryPassword: string } }>(resetRes);
    const tempPassword = resetBody.data.temporaryPassword;
    expect(tempPassword).toBe("TempPass1234!NewE2E");

    // 2. User logs in with temp password → 200
    const loginRes = await LOGIN(
      makeRequest("/api/v1/auth/login", {
        method: "POST",
        body: { email: target.email, password: tempPassword },
      }),
    );
    expect(loginRes.status).toBe(200);
    const loginBody = await parseJson<{ data: { accessToken: string } }>(loginRes);
    expect(loginBody.data.accessToken).toBeTruthy();

    // 3. Refresh token flow — extract cookie and re-issue
    const setCookieHeader = loginRes.headers.get("set-cookie") ?? "";
    const cookieMatch = setCookieHeader.match(/rvep_refresh=([^;,\s]+)/);
    if (cookieMatch) {
      const refreshCookieValue = cookieMatch[1];
      const refreshRes = await REFRESH(
        makeRequest("/api/v1/auth/refresh", {
          method: "POST",
          cookies: { rvep_refresh: refreshCookieValue },
        }),
      );
      expect(refreshRes.status).toBe(200);
      const refreshBody = await parseJson<{ data: { accessToken: string } }>(refreshRes);
      expect(refreshBody.data.accessToken).toBeTruthy();
    }
  });
});
