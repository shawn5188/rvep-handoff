/**
 * c15 P7 — Unit tests for audit-retention.ts.
 *
 * Uses real pglite DB (globalSetup) with direct Prisma writes.
 * No mocks — we test the actual deleteMany + archive logic.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import * as zlib from "zlib";
import { promisify } from "util";
import { prisma } from "@/lib/db";
import { EventLogCategory } from "@prisma/client";
import { pruneOldAuditEvents } from "@/lib/audit-retention";

const gunzip = promisify(zlib.gunzip);

/** Days-ago helper for seeding. */
function daysAgo(d: number): Date {
  return new Date(Date.now() - d * 24 * 60 * 60 * 1000);
}

/** Seed EventLog rows of a given category. */
async function seedEvents(
  count: number,
  opts: { daysOld: number; category?: EventLogCategory; eventName?: string },
) {
  const ts = daysAgo(opts.daysOld);
  await prisma.eventLog.createMany({
    data: Array.from({ length: count }, (_, i) => ({
      eventName: opts.eventName ?? "test_event",
      category: opts.category ?? EventLogCategory.AUDIT,
      ts,
      
      actorId: null,
      userId: null,
    })),
  });
}

// ---------------------------------------------------------------------------
// Case 1: 90-day-old rows are deleted (no archiveDir)
// ---------------------------------------------------------------------------

describe("pruneOldAuditEvents — no archiveDir", () => {
  it("deletes AUDIT rows older than 90 days", async () => {
    await seedEvents(3, { daysOld: 100, category: EventLogCategory.AUDIT });

    const result = await pruneOldAuditEvents({ hotRetentionDays: 90 });

    expect(result.deleted).toBe(3);
    expect(result.archived).toBe(0);
    expect(result.archiveFile).toBeUndefined();

    const remaining = await prisma.eventLog.count({
      where: { eventName: "test_event" },
    });
    expect(remaining).toBe(0);
  });

  it("preserves AUDIT rows newer than 90 days", async () => {
    await seedEvents(2, { daysOld: 80, category: EventLogCategory.AUDIT });
    await seedEvents(3, { daysOld: 100, category: EventLogCategory.AUDIT });

    const result = await pruneOldAuditEvents({ hotRetentionDays: 90 });

    expect(result.deleted).toBe(3);

    const remaining = await prisma.eventLog.count({
      where: { eventName: "test_event", category: EventLogCategory.AUDIT },
    });
    expect(remaining).toBe(2);
  });

  it("deletes SYSTEM category rows older than threshold", async () => {
    await seedEvents(2, { daysOld: 95, category: EventLogCategory.SYSTEM });

    const result = await pruneOldAuditEvents({ hotRetentionDays: 90 });

    expect(result.deleted).toBe(2);
  });

  it("does not delete TELEMETRY category rows", async () => {
    await seedEvents(5, { daysOld: 100, category: EventLogCategory.TELEMETRY });

    const result = await pruneOldAuditEvents({ hotRetentionDays: 90 });

    // Telemetry rows should remain
    expect(result.deleted).toBe(0);
    const remaining = await prisma.eventLog.count({
      where: { category: EventLogCategory.TELEMETRY },
    });
    expect(remaining).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Case 3: archiveDir provided → write .gz + roundtrip verify
// ---------------------------------------------------------------------------

describe("pruneOldAuditEvents — with archiveDir", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("writes gzip archive and roundtrips JSONL content", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rvep-audit-test-"));
    await seedEvents(5, {
      daysOld: 100,
      category: EventLogCategory.AUDIT,
      eventName: "archive_event",
    });

    const result = await pruneOldAuditEvents({
      hotRetentionDays: 90,
      archiveDir: tmpDir,
    });

    expect(result.deleted).toBe(5);
    expect(result.archived).toBe(5);
    expect(result.archiveFile).toBeTruthy();

    // Roundtrip: decompress and parse JSONL
    const compressed = await fs.readFile(result.archiveFile!);
    const decompressed = await gunzip(compressed);
    const jsonl = decompressed.toString("utf8");
    const lines = jsonl.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(5);

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.every((r: { eventName: string }) => r.eventName === "archive_event")).toBe(true);
    // id should be a string (BigInt serialised)
    expect(parsed.every((r: { id: string }) => typeof r.id === "string")).toBe(true);
  });

  it("skips archive file creation and returns archived=0 when no rows match", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rvep-audit-test-"));

    const result = await pruneOldAuditEvents({
      hotRetentionDays: 90,
      archiveDir: tmpDir,
    });

    expect(result.deleted).toBe(0);
    expect(result.archived).toBe(0);
    expect(result.archiveFile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Case 4: no archiveDir → direct delete, archived=0
// ---------------------------------------------------------------------------

describe("pruneOldAuditEvents — archived=0 without archiveDir", () => {
  it("deletes rows and returns archived=0 when archiveDir not provided", async () => {
    await seedEvents(4, { daysOld: 95, category: EventLogCategory.AUDIT });

    const result = await pruneOldAuditEvents({ hotRetentionDays: 90 });

    expect(result.deleted).toBeGreaterThan(0);
    expect(result.archived).toBe(0);
    expect(result.archiveFile).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Case 5: batch of 3000 rows → verify deleted = 3000
// ---------------------------------------------------------------------------

describe("pruneOldAuditEvents — large batch", () => {
  it("deletes 3000 old rows across multiple batches", async () => {
    // Insert in smaller createMany calls to avoid pglite limits
    const chunkSize = 500;
    for (let i = 0; i < 6; i++) {
      await seedEvents(chunkSize, {
        daysOld: 100,
        category: EventLogCategory.AUDIT,
        eventName: "bulk_old_event",
      });
    }

    const result = await pruneOldAuditEvents({ hotRetentionDays: 90 });

    expect(result.deleted).toBe(3000);
    expect(result.archived).toBe(0);
  });
}, 60_000);
