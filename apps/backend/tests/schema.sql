-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "VehicleType" AS ENUM ('QUADRUPED', 'WHEELED', 'WHEELED_QUADRUPED', 'RC_CAR', 'DRONE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "VehicleStatus" AS ENUM ('ONLINE', 'OFFLINE', 'SAFE_MODE', 'DISCONNECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SessionPurpose" AS ENUM ('CONTROL', 'MONITOR', 'DATASET', 'RAW');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'CLOSED', 'FATAL');

-- CreateEnum
CREATE TYPE "LeaseStatus" AS ENUM ('ACTIVE', 'LOCKED', 'RECONNECTED_LOCKED', 'RELEASED', 'REVOKED');

-- CreateEnum
CREATE TYPE "DatasetAssetKind" AS ENUM ('RAW', 'ANNOTATED', 'EGRESS_PER_TRACK', 'EGRESS_COMPOSITE', 'METADATA', 'LOG');

-- CreateEnum
CREATE TYPE "DatasetAssetSource" AS ENUM ('ORIN_LOCAL', 'ORIN_RSYNC', 'LIVEKIT_EGRESS', 'MANUAL_UPLOAD');

-- CreateEnum
CREATE TYPE "RetentionTier" AS ENUM ('EPHEMERAL', 'ROLLING_30D', 'ROLLING_90D', 'PERMANENT');

-- CreateEnum
CREATE TYPE "EventLogCategory" AS ENUM ('AUDIT', 'TELEMETRY', 'SYSTEM');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "refreshTokenVersion" INTEGER NOT NULL DEFAULT 0,
    "displayName" TEXT,
    "invitePending" BOOLEAN NOT NULL DEFAULT false,
    "inviteToken" TEXT,
    "inviteExpiresAt" TIMESTAMP(3),
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "vehicleType" "VehicleType" NOT NULL,
    "adapterType" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "cameraProfileId" TEXT NOT NULL,
    "audioProfileId" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL,
    "status" "VehicleStatus" NOT NULL DEFAULT 'OFFLINE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "vendor" TEXT,
    "serialNumber" TEXT,
    "declaredCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "observedCapabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxLinearMs" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "maxAngularRads" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "createdBy" TEXT,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VehiclePermission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "grantedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "priorityOverride" INTEGER,

    CONSTRAINT "VehiclePermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "SessionPurpose" NOT NULL,
    "connectionEpoch" BIGINT NOT NULL DEFAULT 1,
    "datasetVersion" TEXT NOT NULL DEFAULT 'v1',
    "datasetPath" TEXT,
    "status" "SessionStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ControlLease" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "connectionEpoch" BIGINT NOT NULL,
    "status" "LeaseStatus" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ControlLease_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryFrame" (
    "id" BIGSERIAL NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "monotonicNs" BIGINT,
    "connectionEpoch" BIGINT NOT NULL,
    "gps" JSONB,
    "imu" JSONB,
    "battery" JSONB,
    "network" JSONB,
    "mode" TEXT,
    "camera" JSONB,
    "audio" JSONB,

    CONSTRAINT "TelemetryFrame_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" BIGSERIAL NOT NULL,
    "vehicleId" TEXT,
    "sessionId" TEXT,
    "userId" TEXT,
    "eventName" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,
    "category" "EventLogCategory",
    "actorId" TEXT,
    "targetType" TEXT,
    "targetId" TEXT,
    "tenantId" TEXT,

    CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NetworkLog" (
    "id" BIGSERIAL NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "connectionEpoch" BIGINT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "state" TEXT NOT NULL,
    "rttMs" DOUBLE PRECISION,
    "jitterMs" DOUBLE PRECISION,
    "packetLoss" DOUBLE PRECISION,
    "reconnectCount" INTEGER,
    "reason" TEXT,

    CONSTRAINT "NetworkLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ControlLog" (
    "id" BIGSERIAL NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "connectionEpoch" BIGINT NOT NULL,
    "seq" BIGINT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "commandType" TEXT NOT NULL,
    "axes" JSONB,
    "accepted" BOOLEAN NOT NULL,
    "rejectedReason" TEXT,
    "adapterResult" JSONB,

    CONSTRAINT "ControlLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DatasetAsset" (
    "id" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "cameraId" TEXT,
    "kind" "DatasetAssetKind" NOT NULL,
    "source" "DatasetAssetSource" NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "durationMs" BIGINT,
    "sha256" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncedAt" TIMESTAMP(3),
    "retentionTier" "RetentionTier" NOT NULL DEFAULT 'ROLLING_30D',
    "metadata" JSONB,

    CONSTRAINT "DatasetAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudioDeviceSnapshot" (
    "id" BIGSERIAL NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "sessionId" TEXT,
    "ts" TIMESTAMP(3) NOT NULL,
    "deviceId" TEXT NOT NULL,
    "displayName" TEXT,
    "driverType" TEXT,
    "sampleRate" INTEGER,
    "inputChannels" INTEGER,
    "status" TEXT NOT NULL,

    CONSTRAINT "AudioDeviceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_inviteToken_key" ON "User"("inviteToken");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_vehicleId_key" ON "Vehicle"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "VehiclePermission_userId_vehicleId_key" ON "VehiclePermission"("userId", "vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionId_key" ON "Session"("sessionId");

-- CreateIndex
CREATE INDEX "ControlLease_vehicleId_status_idx" ON "ControlLease"("vehicleId", "status");

-- CreateIndex
CREATE INDEX "TelemetryFrame_vehicleId_ts_idx" ON "TelemetryFrame"("vehicleId", "ts");

-- CreateIndex
CREATE INDEX "TelemetryFrame_sessionId_ts_idx" ON "TelemetryFrame"("sessionId", "ts");

-- CreateIndex
CREATE INDEX "EventLog_vehicleId_ts_idx" ON "EventLog"("vehicleId", "ts");

-- CreateIndex
CREATE INDEX "EventLog_eventName_ts_idx" ON "EventLog"("eventName", "ts");

-- CreateIndex
CREATE INDEX "EventLog_actorId_ts_idx" ON "EventLog"("actorId", "ts");

-- CreateIndex
CREATE INDEX "EventLog_targetType_targetId_ts_idx" ON "EventLog"("targetType", "targetId", "ts");

-- CreateIndex
CREATE INDEX "EventLog_tenantId_ts_idx" ON "EventLog"("tenantId", "ts");

-- CreateIndex
CREATE INDEX "EventLog_category_ts_idx" ON "EventLog"("category", "ts");

-- CreateIndex
CREATE INDEX "ControlLog_sessionId_ts_idx" ON "ControlLog"("sessionId", "ts");

-- CreateIndex
CREATE INDEX "ControlLog_vehicleId_ts_idx" ON "ControlLog"("vehicleId", "ts");

-- AddForeignKey
ALTER TABLE "VehiclePermission" ADD CONSTRAINT "VehiclePermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehiclePermission" ADD CONSTRAINT "VehiclePermission_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehiclePermission" ADD CONSTRAINT "VehiclePermission_grantedBy_fkey" FOREIGN KEY ("grantedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlLease" ADD CONSTRAINT "ControlLease_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlLease" ADD CONSTRAINT "ControlLease_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlLease" ADD CONSTRAINT "ControlLease_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryFrame" ADD CONSTRAINT "TelemetryFrame_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkLog" ADD CONSTRAINT "NetworkLog_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NetworkLog" ADD CONSTRAINT "NetworkLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlLog" ADD CONSTRAINT "ControlLog_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ControlLog" ADD CONSTRAINT "ControlLog_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetAsset" ADD CONSTRAINT "DatasetAsset_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetAsset" ADD CONSTRAINT "DatasetAsset_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioDeviceSnapshot" ADD CONSTRAINT "AudioDeviceSnapshot_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("vehicleId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudioDeviceSnapshot" ADD CONSTRAINT "AudioDeviceSnapshot_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;

