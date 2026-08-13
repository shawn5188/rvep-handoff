-- c15 P1 — Admin Onboarding Suite
-- Generated 2026-06-07 per c15-p1-migration-design.md §3 + §6 fork resolution

-- New enum: EventLog category (per §6 fork 3)
CREATE TYPE "EventLogCategory" AS ENUM ('AUDIT', 'TELEMETRY', 'SYSTEM');

-- User: invite flow + 2FA-ready + soft delete + displayName
ALTER TABLE "User"
  ADD COLUMN "displayName" TEXT,
  ADD COLUMN "invitePending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "inviteToken" TEXT,
  ADD COLUMN "inviteExpiresAt" TIMESTAMP(3),
  ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "twoFactorSecret" TEXT,
  ADD COLUMN "archivedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "User_inviteToken_key" ON "User"("inviteToken");

-- VehiclePermission: priority override (per c14)
ALTER TABLE "VehiclePermission"
  ADD COLUMN "priorityOverride" INTEGER;

-- Vehicle: vendor / serial / capability arrays / motion limits / audit
ALTER TABLE "Vehicle"
  ADD COLUMN "vendor" TEXT,
  ADD COLUMN "serialNumber" TEXT,
  ADD COLUMN "declaredCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "observedCapabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "maxLinearMs" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  ADD COLUMN "maxAngularRads" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  ADD COLUMN "createdBy" TEXT,
  ADD COLUMN "archivedAt" TIMESTAMP(3);

-- EventLog: upgrade to audit-capable log (category + actor/target/tenant + indexes)
ALTER TABLE "EventLog"
  ADD COLUMN "category" "EventLogCategory",
  ADD COLUMN "actorId" TEXT,
  ADD COLUMN "targetType" TEXT,
  ADD COLUMN "targetId" TEXT,
  ADD COLUMN "tenantId" TEXT;

CREATE INDEX "EventLog_actorId_ts_idx" ON "EventLog"("actorId", "ts");
CREATE INDEX "EventLog_targetType_targetId_ts_idx" ON "EventLog"("targetType", "targetId", "ts");
CREATE INDEX "EventLog_tenantId_ts_idx" ON "EventLog"("tenantId", "ts");
CREATE INDEX "EventLog_category_ts_idx" ON "EventLog"("category", "ts");
