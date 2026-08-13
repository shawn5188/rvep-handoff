import { describe, it, expect } from "vitest";
import { prisma } from "@/lib/db";
import { EventLogCategory, Prisma, Role } from "@prisma/client";
import { GET as GET_AUDIT } from "@/app/api/v1/admin/audit/route";
import { GET as GET_EXPORT } from "@/app/api/v1/admin/audit/export/route";
import {
  classifyImportance,
  decodeCursor,
  encodeCursor,
  EXPORT_MAX_ROWS,
} from "@/lib/admin-audit-serializer";
import { makeRequest, parseJson } from "../request-helpers";
import { createUser, createVehicle, loginAs, bearerHeader } from "../factories";

async function adminActor() {
  const admin = await createUser({ role: Role.ADMIN });
  const token = await loginAs(admin.id, admin.role);
  return { admin, token };
}

function listAudit(token: string, qs = "") {
  return GET_AUDIT(
    makeRequest(`/api/v1/admin/audit${qs ? `?${qs}` : ""}`, {
      headers: bearerHeader(token),
    }),
    undefined,
  );
}

function exportAudit(token: string, qs = "") {
  return GET_EXPORT(
    makeRequest(`/api/v1/admin/audit/export${qs ? `?${qs}` : ""}`, {
      headers: bearerHeader(token),
    }),
    undefined,
  );
}

interface SerializedEvent {
  id: string;
  ts: string;
  category: string | null;
  eventName: string;
  actorId: string | null;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  payload: Record<string, unknown> | null;
  tenantId: string | null;
  importance: "red" | "orange" | "default";
}

interface AuditPage {
  data: { events: SerializedEvent[]; nextCursor: string | null };
}

/** Seed one AUDIT EventLog row with an explicit timestamp. */
function seedEvent(opts: {
  eventName: string;
  ts: Date;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
  category?: EventLogCategory;
}) {
  return prisma.eventLog.create({
    data: {
      eventName: opts.eventName,
      category: opts.category ?? EventLogCategory.AUDIT,
      ts: opts.ts,
      actorId: opts.actorId ?? null,
      userId: opts.actorId ?? null,
      targetType: opts.targetType ?? null,
      targetId: opts.targetId ?? null,
      payload: opts.payload
        ? (opts.payload as Prisma.InputJsonValue)
        : undefined,
    },
  });
}

/** Timestamps safely in the past so admin_api_access rows sort above them. */
function minutesAgo(min: number): Date {
  return new Date(Date.now() - min * 60_000);
}

describe("Admin Audit Log (c15 P6)", () => {
  describe("GET /admin/audit", () => {
    it("returns AUDIT events newest-first with actor / target labels", async () => {
      const { admin, token } = await adminActor();
      const target = await createUser({ role: Role.OPERATOR });
      const vehicle = await createVehicle("audit-view");

      await seedEvent({
        eventName: "user_created",
        ts: minutesAgo(10),
        actorId: admin.id,
        targetType: "User",
        targetId: target.id,
        payload: { email: target.email },
      });
      await seedEvent({
        eventName: "vehicle_created",
        ts: minutesAgo(5),
        actorId: admin.id,
        targetType: "Vehicle",
        targetId: vehicle.vehicleId, // external machine id, per P3 convention
      });

      const res = await listAudit(token, "eventName=user_created,vehicle_created");
      const json = await parseJson<AuditPage>(res);

      expect(res.status).toBe(200);
      expect(json.data.events).toHaveLength(2);
      expect(json.data.nextCursor).toBeNull();

      // Newest first.
      const [vehicleEvt, userEvt] = json.data.events;
      expect(vehicleEvt.eventName).toBe("vehicle_created");
      expect(vehicleEvt.actorEmail).toBe(admin.email);
      expect(vehicleEvt.targetType).toBe("Vehicle");
      expect(vehicleEvt.targetId).toBe(vehicle.vehicleId);
      expect(vehicleEvt.targetLabel).toBe(vehicle.displayName);
      expect(vehicleEvt.category).toBe("AUDIT");
      expect(vehicleEvt.importance).toBe("default");

      expect(userEvt.eventName).toBe("user_created");
      expect(userEvt.targetType).toBe("User");
      expect(userEvt.targetId).toBe(target.id);
      expect(userEvt.targetLabel).toBe(target.email);
      expect(userEvt.payload).toEqual({ email: target.email });
    });

    it("paginates with a keyset cursor (no overlap, no gap)", async () => {
      const { admin, token } = await adminActor();
      for (let i = 0; i < 5; i++) {
        await seedEvent({
          eventName: "page_event",
          ts: minutesAgo(60 - i), // i=4 is the newest
          actorId: admin.id,
          payload: { seq: i },
        });
      }

      const p1 = await listAudit(token, "eventName=page_event&limit=2");
      const j1 = await parseJson<AuditPage>(p1);
      expect(p1.status).toBe(200);
      expect(j1.data.events).toHaveLength(2);
      expect(j1.data.nextCursor).not.toBeNull();
      expect(j1.data.events.map((e) => e.payload?.seq)).toEqual([4, 3]);

      const p2 = await listAudit(
        token,
        `eventName=page_event&limit=2&cursor=${encodeURIComponent(j1.data.nextCursor!)}`,
      );
      const j2 = await parseJson<AuditPage>(p2);
      expect(j2.data.events.map((e) => e.payload?.seq)).toEqual([2, 1]);
      expect(j2.data.nextCursor).not.toBeNull();

      const p3 = await listAudit(
        token,
        `eventName=page_event&limit=2&cursor=${encodeURIComponent(j2.data.nextCursor!)}`,
      );
      const j3 = await parseJson<AuditPage>(p3);
      expect(j3.data.events.map((e) => e.payload?.seq)).toEqual([0]);
      expect(j3.data.nextCursor).toBeNull();
    });

    it("breaks ts ties by id in the keyset cursor", async () => {
      const { admin, token } = await adminActor();
      const sameTs = minutesAgo(30);
      for (let i = 0; i < 3; i++) {
        await seedEvent({
          eventName: "tie_event",
          ts: sameTs,
          actorId: admin.id,
          payload: { seq: i },
        });
      }

      const p1 = await listAudit(token, "eventName=tie_event&limit=2");
      const j1 = await parseJson<AuditPage>(p1);
      const p2 = await listAudit(
        token,
        `eventName=tie_event&limit=2&cursor=${encodeURIComponent(j1.data.nextCursor!)}`,
      );
      const j2 = await parseJson<AuditPage>(p2);

      const ids = [...j1.data.events, ...j2.data.events].map((e) => e.id);
      expect(new Set(ids).size).toBe(3); // all 3, no dupes across pages
    });

    it("filters by eventName / actorId / targetType / targetId / since / until", async () => {
      const { admin, token } = await adminActor();
      const otherAdmin = await createUser({ role: Role.ADMIN });
      const user = await createUser({ role: Role.VIEWER });

      await seedEvent({
        eventName: "user_created",
        ts: minutesAgo(50),
        actorId: admin.id,
        targetType: "User",
        targetId: user.id,
      });
      await seedEvent({
        eventName: "vehicle_created",
        ts: minutesAgo(40),
        actorId: otherAdmin.id,
        targetType: "Vehicle",
        targetId: "amr-filter-01",
      });
      await seedEvent({
        eventName: "user_password_reset",
        ts: minutesAgo(30),
        actorId: admin.id,
        targetType: "User",
        targetId: user.id,
      });

      // eventName (comma list)
      const byName = await parseJson<AuditPage>(
        await listAudit(token, "eventName=user_created,vehicle_created"),
      );
      expect(byName.data.events.map((e) => e.eventName).sort()).toEqual([
        "user_created",
        "vehicle_created",
      ]);

      // actorId — restrict to seeded names so this call's own
      // admin_api_access row does not leak in.
      const byActor = await parseJson<AuditPage>(
        await listAudit(
          token,
          `actorId=${otherAdmin.id}&eventName=user_created,vehicle_created,user_password_reset`,
        ),
      );
      expect(byActor.data.events).toHaveLength(1);
      expect(byActor.data.events[0].eventName).toBe("vehicle_created");

      // targetType
      const byType = await parseJson<AuditPage>(
        await listAudit(token, "targetType=Vehicle"),
      );
      expect(byType.data.events).toHaveLength(1);
      expect(byType.data.events[0].targetId).toBe("amr-filter-01");

      // targetId
      const byTarget = await parseJson<AuditPage>(
        await listAudit(token, `targetId=${user.id}`),
      );
      expect(byTarget.data.events.map((e) => e.eventName).sort()).toEqual([
        "user_created",
        "user_password_reset",
      ]);

      // since / until window that only contains the middle event
      const since = minutesAgo(45).toISOString();
      const until = minutesAgo(35).toISOString();
      const byWindow = await parseJson<AuditPage>(
        await listAudit(token, `since=${since}&until=${until}`),
      );
      expect(byWindow.data.events).toHaveLength(1);
      expect(byWindow.data.events[0].eventName).toBe("vehicle_created");
    });

    it("defaults to category=AUDIT and can query other categories", async () => {
      const { admin, token } = await adminActor();
      await seedEvent({
        eventName: "audit_row",
        ts: minutesAgo(20),
        actorId: admin.id,
      });
      await seedEvent({
        eventName: "system_row",
        ts: minutesAgo(20),
        category: EventLogCategory.SYSTEM,
      });

      const defaultRes = await parseJson<AuditPage>(
        await listAudit(token, "eventName=audit_row,system_row"),
      );
      expect(defaultRes.data.events.map((e) => e.eventName)).toEqual(["audit_row"]);

      const systemRes = await parseJson<AuditPage>(
        await listAudit(token, "eventName=audit_row,system_row&category=SYSTEM"),
      );
      expect(systemRes.data.events.map((e) => e.eventName)).toEqual(["system_row"]);
      expect(systemRes.data.events[0].category).toBe("SYSTEM");
    });

    it("rejects non-admin callers with 403", async () => {
      const op = await createUser({ role: Role.OPERATOR });
      const token = await loginAs(op.id, op.role);
      const res = await listAudit(token);
      expect(res.status).toBe(403);
      expect((await parseJson<{ error: string }>(res)).error).toBe("admin_required");
    });

    it("422 on unknown query params (.strict()) and bad values", async () => {
      const { token } = await adminActor();

      const unknown = await listAudit(token, "vehicleFilter=amr-01");
      expect(unknown.status).toBe(422);
      expect((await parseJson<{ error: string }>(unknown)).error).toBe(
        "validation_error",
      );

      expect((await listAudit(token, "limit=0")).status).toBe(422);
      expect((await listAudit(token, "limit=501")).status).toBe(422);
      expect((await listAudit(token, "since=not-a-date")).status).toBe(422);
      expect((await listAudit(token, "category=BOGUS")).status).toBe(422);
      expect((await listAudit(token, "actorId=not-a-uuid")).status).toBe(422);
      expect((await listAudit(token, "cursor=%%%garbage")).status).toBe(422);
    });
  });

  describe("GET /admin/audit/export", () => {
    it("exports filtered events as UTF-8 BOM CSV with escaped cells", async () => {
      const { admin, token } = await adminActor();
      await seedEvent({
        eventName: "csv_event",
        ts: minutesAgo(15),
        actorId: admin.id,
        targetType: "User",
        targetId: admin.id,
        payload: { note: 'has "quotes", commas' },
      });
      await seedEvent({
        eventName: "csv_event",
        ts: minutesAgo(10),
        actorId: admin.id,
      });
      await seedEvent({ eventName: "other_event", ts: minutesAgo(5), actorId: admin.id });

      const res = await exportAudit(token, "eventName=csv_event");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("content-disposition")).toMatch(
        /^attachment; filename="rvep-audit-.*\.csv"$/,
      );

      // Response.text() strips the BOM per fetch spec \u2014 check raw bytes.
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // Excel BOM
      const body = new TextDecoder("utf-8").decode(bytes); // decoder drops BOM
      const lines = body.replace(/^\uFEFF/, "").trimEnd().split("\r\n");
      expect(lines).toHaveLength(3); // header + 2 filtered rows
      expect(lines[0]).toBe(
        "ts,category,eventName,importance,actorEmail,targetType,targetId,targetLabel,payloadJSON",
      );
      // Payload JSON with quotes/commas is RFC-4180 escaped.
      expect(lines[2]).toContain('"{""note"":""has \\""quotes\\"", commas""}"');
      expect(lines[2]).toContain(admin.email);
    });

    it("writes an audit_log_exported audit row with rowCount + filter", async () => {
      const { admin, token } = await adminActor();
      await seedEvent({ eventName: "csv_event", ts: minutesAgo(5), actorId: admin.id });

      const res = await exportAudit(token, "eventName=csv_event");
      expect(res.status).toBe(200);

      const row = await prisma.eventLog.findFirst({
        where: { eventName: "audit_log_exported", actorId: admin.id },
      });
      expect(row).not.toBeNull();
      expect(row?.payload).toMatchObject({
        rowCount: 1,
        filter: { category: "AUDIT", eventName: ["csv_event"] },
      });
    });

    it("400 export_too_large beyond the hard cap", async () => {
      const { admin, token } = await adminActor();
      await prisma.eventLog.createMany({
        data: Array.from({ length: EXPORT_MAX_ROWS + 1 }, () => ({
          eventName: "bulk_event",
          category: EventLogCategory.AUDIT,
          actorId: admin.id,
          userId: admin.id,
          ts: minutesAgo(90),
        })),
      });

      const res = await exportAudit(token, "eventName=bulk_event");
      expect(res.status).toBe(400);
      const json = await parseJson<{ error: string; rowCount: number; maxRows: number }>(res);
      expect(json.error).toBe("export_too_large");
      expect(json.rowCount).toBe(EXPORT_MAX_ROWS + 1);
      expect(json.maxRows).toBe(EXPORT_MAX_ROWS);
    });

    it("rejects non-admin callers with 403 and unknown params with 422", async () => {
      const op = await createUser({ role: Role.OPERATOR });
      const opToken = await loginAs(op.id, op.role);
      expect((await exportAudit(opToken)).status).toBe(403);

      const { token } = await adminActor();
      expect((await exportAudit(token, "limit=100")).status).toBe(422); // no limit on export
      expect((await exportAudit(token, "cursor=abc")).status).toBe(422); // no cursor on export
    });
  });

  describe("classifyImportance", () => {
    it.each<[string, Record<string, unknown> | undefined, string]>([
      // red — privilege escalation / destructive
      ["user_role_changed", { from: "OPERATOR", to: "ADMIN" }, "red"],
      ["user_archived", { email: "x@y.z" }, "red"],
      ["vehicle_archived", undefined, "red"],
      // orange — security-sensitive routine ops
      ["lease_forced_release", undefined, "orange"],
      ["user_password_reset", { method: "invite_link" }, "orange"],
      ["vehicle_token_minted", { ttl: 8 * 24 * 3600 }, "orange"], // > 7d
      ["user_permissions_updated", { added: 6, removed: 3, changed: 2 }, "orange"], // 11 rows
      // default — everything else
      ["user_role_changed", { from: "VIEWER", to: "OPERATOR" }, "default"],
      ["vehicle_token_minted", { ttl: 3600 }, "default"],
      ["user_permissions_updated", { added: 1, removed: 0, changed: 0 }, "default"],
      ["vehicle_created", undefined, "default"],
      ["admin_api_access", { method: "GET", path: "/x" }, "default"],
    ])("%s %o → %s", (eventName, payload, expected) => {
      expect(classifyImportance(eventName, payload ?? null)).toBe(expected);
    });

    it("is reflected in the API response", async () => {
      const { admin, token } = await adminActor();
      const user = await createUser({ role: Role.OPERATOR });
      await seedEvent({
        eventName: "user_role_changed",
        ts: minutesAgo(5),
        actorId: admin.id,
        targetType: "User",
        targetId: user.id,
        payload: { email: user.email, from: "OPERATOR", to: "ADMIN" },
      });

      const json = await parseJson<AuditPage>(
        await listAudit(token, "eventName=user_role_changed"),
      );
      expect(json.data.events[0].importance).toBe("red");
    });
  });

  describe("cursor encoding", () => {
    it("roundtrips id + ts", () => {
      const ts = new Date("2026-06-14T12:34:56.789Z");
      const cursor = encodeCursor(BigInt("9007199254740993"), ts); // > MAX_SAFE_INTEGER
      const decoded = decodeCursor(cursor);
      expect(decoded).not.toBeNull();
      expect(decoded!.id).toBe(BigInt("9007199254740993"));
      expect(decoded!.ts.toISOString()).toBe(ts.toISOString());
    });

    it("returns null on garbage / malformed cursors", () => {
      expect(decodeCursor("not-base64!@#")).toBeNull();
      expect(
        decodeCursor(Buffer.from("[1,2,3]", "utf8").toString("base64url")),
      ).toBeNull();
      expect(
        decodeCursor(
          Buffer.from(JSON.stringify({ id: "abc", ts: "2026-01-01T00:00:00Z" })).toString(
            "base64url",
          ),
        ),
      ).toBeNull();
      expect(
        decodeCursor(
          Buffer.from(JSON.stringify({ id: "12", ts: "not-a-date" })).toString("base64url"),
        ),
      ).toBeNull();
    });
  });
});
