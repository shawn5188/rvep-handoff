#!/usr/bin/env tsx
/**
 * c15 P7 — CLI runner for audit pruning.
 *
 * Usage:
 *   pnpm exec tsx src/scripts/prune-audit.ts [--archive-dir=/path/to/archive]
 *
 * Env vars (override defaults):
 *   AUDIT_HOT_RETENTION_DAYS  — how many days to keep (default 90)
 *   AUDIT_ARCHIVE_DIR         — archive directory (default: none)
 *
 * Exit codes:
 *   0 — success
 *   1 — failure
 */

import { pruneOldAuditEvents } from "@/lib/audit-retention";

async function main() {
  const args = process.argv.slice(2);

  // Parse --archive-dir=<path>
  let archiveDir: string | undefined;
  for (const arg of args) {
    const match = arg.match(/^--archive-dir=(.+)$/);
    if (match) {
      archiveDir = match[1];
    }
  }

  const hotRetentionDays = parseInt(
    process.env.AUDIT_HOT_RETENTION_DAYS ?? "90",
    10,
  );
  if (!Number.isFinite(hotRetentionDays) || hotRetentionDays < 1) {
    console.error(
      `[prune-audit] Invalid AUDIT_HOT_RETENTION_DAYS: ${process.env.AUDIT_HOT_RETENTION_DAYS}`,
    );
    process.exit(1);
  }

  const effectiveArchiveDir = archiveDir ?? process.env.AUDIT_ARCHIVE_DIR;

  console.log(
    `[prune-audit] Pruning audit events older than ${hotRetentionDays} days` +
      (effectiveArchiveDir ? ` → archive: ${effectiveArchiveDir}` : " (no archive)"),
  );

  try {
    const result = await pruneOldAuditEvents({
      hotRetentionDays,
      archiveDir: effectiveArchiveDir,
    });

    console.log(`[prune-audit] Done:`);
    console.log(`  deleted : ${result.deleted}`);
    console.log(`  archived: ${result.archived}`);
    if (result.archiveFile) {
      console.log(`  file    : ${result.archiveFile}`);
    }
  } catch (err) {
    console.error("[prune-audit] Failed:", err);
    process.exit(1);
  }
}

main();
