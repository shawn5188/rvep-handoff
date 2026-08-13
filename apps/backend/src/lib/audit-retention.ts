/**
 * c15 P7 — Audit retention / pruning helper.
 *
 * Deletes EventLog rows older than `hotRetentionDays` in batches.
 * Optionally archives them to a gzip JSONL file before deletion.
 *
 * Only AUDIT and SYSTEM category rows are considered for pruning
 * (TELEMETRY rows are managed by a separate telemetry retention policy).
 *
 * Usage:
 *   await pruneOldAuditEvents({ hotRetentionDays: 90 });
 *   await pruneOldAuditEvents({ hotRetentionDays: 90, archiveDir: '/var/lib/rvep/archive' });
 */

import { prisma } from "@/lib/db";
import { EventLogCategory, Prisma } from "@prisma/client";
import * as fs from "fs/promises";
import * as path from "path";
import * as zlib from "zlib";
import { promisify } from "util";

const gzip = promisify(zlib.gzip);

const BATCH_SIZE = 1000;
const PRUNABLE_CATEGORIES = [EventLogCategory.AUDIT, EventLogCategory.SYSTEM];

export interface PruneOptions {
  /** How many days to keep in the hot DB table (e.g. 90). */
  hotRetentionDays: number;
  /**
   * Directory to write the gzip archive to before deletion.
   * If omitted, rows are deleted directly without archiving.
   */
  archiveDir?: string;
}

export interface PruneResult {
  /** Total rows deleted. */
  deleted: number;
  /** Total rows written to the archive file (0 if no archiveDir). */
  archived: number;
  /** Path to the archive file, or undefined if no archive was written. */
  archiveFile?: string;
}

/** Shared where clause type for the pruning queries. */
type PruneWhere = Prisma.EventLogWhereInput;

/**
 * Prune audit EventLog rows older than `hotRetentionDays`.
 *
 * When `archiveDir` is given:
 *  1. Collect all matching rows in batches.
 *  2. Serialise to gzip JSONL → `archiveDir/audit-YYYY-MM-DD.jsonl.gz`.
 *  3. Delete matching rows from the DB.
 *
 * Without `archiveDir`: delete directly.
 */
export async function pruneOldAuditEvents(opts: PruneOptions): Promise<PruneResult> {
  const { hotRetentionDays, archiveDir } = opts;
  const cutoffDate = new Date(Date.now() - hotRetentionDays * 24 * 60 * 60 * 1000);

  const baseWhere: PruneWhere = {
    ts: { lt: cutoffDate },
    category: { in: PRUNABLE_CATEGORIES },
  };

  if (archiveDir) {
    return pruneWithArchive(baseWhere, archiveDir, cutoffDate);
  }

  return pruneDirectDelete(baseWhere);
}

// ---------------------------------------------------------------------------
// Internal: prune with gzip archive
// ---------------------------------------------------------------------------

async function pruneWithArchive(
  baseWhere: PruneWhere,
  archiveDir: string,
  cutoffDate: Date,
): Promise<PruneResult> {
  // Collect all rows to archive (batched to avoid OOM on large tables)
  const allRows: object[] = [];
  let offset = 0;

  while (true) {
    const batch = await prisma.eventLog.findMany({
      where: baseWhere,
      take: BATCH_SIZE,
      skip: offset,
      orderBy: { id: "asc" },
    });
    if (batch.length === 0) break;

    for (const row of batch) {
      allRows.push({
        ...row,
        id: row.id.toString(), // BigInt → string for JSON
      });
    }
    offset += batch.length;
    if (batch.length < BATCH_SIZE) break;
  }

  const archived = allRows.length;

  let archiveFile: string | undefined;
  if (archived > 0) {
    await fs.mkdir(archiveDir, { recursive: true });
    const stamp = cutoffDate.toISOString().slice(0, 10); // YYYY-MM-DD
    archiveFile = path.join(archiveDir, `audit-${stamp}.jsonl.gz`);
    const jsonl = allRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    const compressed = await gzip(Buffer.from(jsonl, "utf8"));
    await fs.writeFile(archiveFile, compressed);
  }

  // Delete the rows from the DB
  const deleteResult = await prisma.eventLog.deleteMany({ where: baseWhere });

  return {
    deleted: deleteResult.count,
    archived,
    archiveFile,
  };
}

// ---------------------------------------------------------------------------
// Internal: direct delete (no archive)
// ---------------------------------------------------------------------------

async function pruneDirectDelete(baseWhere: PruneWhere): Promise<PruneResult> {
  const deleteResult = await prisma.eventLog.deleteMany({ where: baseWhere });

  return {
    deleted: deleteResult.count,
    archived: 0,
  };
}
