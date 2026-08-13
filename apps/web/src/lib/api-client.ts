"use client";

// Dynamic API base: use NEXT_PUBLIC_API_BASE if set; otherwise derive from current
// browser location so LAN access (iPhone / partner laptop) works without env var.
const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ??
  (typeof window !== "undefined"
    ? `${window.location.protocol}//${window.location.hostname}:3010`
    : "http://localhost:3010");

let accessToken: string | null = null;
let accessExpiresAt: number = 0;
const listeners: Array<() => void> = [];

function notify(): void {
  for (const fn of listeners) fn();
}

export function onAuthChange(fn: () => void): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function isAuthenticated(): boolean {
  return accessToken !== null && Date.now() < accessExpiresAt;
}

/**
 * Silent refresh: schedule an auto-refresh 5 minutes before expiry so the
 * operator never gets kicked out mid-control. spec: openspec/api/livekit-token.md
 * + reviewer feedback that 401 mid-control is a safety incident, not a UX issue.
 */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh(expiresAtIso: string): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const expMs = new Date(expiresAtIso).getTime();
  const fireIn = Math.max(0, expMs - Date.now() - REFRESH_MARGIN_MS);
  refreshTimer = setTimeout(() => {
    void refresh();
  }, fireIn);
}

function cancelRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

function setAccess(token: string, expiresAtIso: string): void {
  accessToken = token;
  accessExpiresAt = new Date(expiresAtIso).getTime();
  scheduleRefresh(expiresAtIso);
  notify();
}

function clearAccess(): void {
  accessToken = null;
  accessExpiresAt = 0;
  cancelRefresh();
  notify();
}

interface ApiResponse<T> {
  data?: T;
  error?: string;
  [key: string]: unknown;
}

async function refresh(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: "POST",
      credentials: "include",
    });
    if (!res.ok) return false;
    const body = (await res.json()) as ApiResponse<{ accessToken: string; expiresAt: string }>;
    if (body.data) {
      setAccess(body.data.accessToken, body.data.expiresAt);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && !retried) {
    const ok = await refresh();
    if (ok) return request(method, path, body, true);
  }

  const json = (await res.json().catch(() => ({}))) as ApiResponse<T>;
  if (!res.ok) {
    throw new ApiError(json.error ?? `http_${res.status}`, res.status, json);
  }
  return json.data as T;
}

export class ApiError extends Error {
  constructor(public code: string, public status: number, public extra?: unknown) {
    super(code);
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface LoginResponse {
  accessToken: string;
  expiresAt: string;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
}

export async function login(email: string, password: string): Promise<LoginResponse> {
  const data = await request<LoginResponse>("POST", "/api/v1/auth/login", { email, password });
  setAccess(data.accessToken, data.expiresAt);
  return data;
}

export async function logout(): Promise<void> {
  try {
    await request<{ ok: true }>("POST", "/api/v1/auth/logout");
  } finally {
    clearAccess();
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface MeResponse {
  userId: string;
  email: string | null;
  displayName: string | null;
  role: "ADMIN" | "OPERATOR" | "VIEWER";
  vehiclePermissions: Array<{ vehicleId: string; role: "ADMIN" | "OPERATOR" | "VIEWER" }>;
}

export function getMe(): Promise<MeResponse> {
  return request<MeResponse>("GET", "/api/v1/permissions/me");
}

// ---------------------------------------------------------------------------
// Vehicles
// ---------------------------------------------------------------------------

export interface Vehicle {
  vehicleId: string;
  displayName: string;
  vehicleType: string;
  status: string;
}

export function listVehicles(): Promise<Vehicle[]> {
  return request<Vehicle[]>("GET", "/api/v1/vehicles");
}

export interface VehicleStatus {
  vehicleId: string;
  displayName: string;
  vehicleType: string;
  status: string;
  lease: {
    operatorId: string;
    operatorName: string;
    sessionId: string;
    status: string;
    expiresAt: string;
  } | null;
  telemetry: {
    ts: string;
    sessionId: string;
    mode: string | null;
    batteryPct: number | null;
    networkRttMs: number | null;
    gps: { lat: number; lng: number } | null;
  } | null;
  lastSeenMs: number | null;
  online: boolean;
}

export function getVehicleStatus(vehicleId: string): Promise<VehicleStatus> {
  return request<VehicleStatus>("GET", `/api/v1/vehicles/${encodeURIComponent(vehicleId)}/status`);
}

export interface AuditEntry {
  id: string;
  vehicleId: string | null;
  sessionId: string | null;
  userId: string | null;
  eventName: string;
  ts: string;
  payload: Record<string, unknown> | null;
}

export function listAudit(vehicleId?: string, limit = 100): Promise<AuditEntry[]> {
  const params = new URLSearchParams();
  if (vehicleId) params.set("vehicleId", vehicleId);
  params.set("limit", String(limit));
  return request<AuditEntry[]>("GET", `/api/v1/audit?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Dataset assets
// ---------------------------------------------------------------------------

export interface DatasetAsset {
  id: string;
  vehicleId: string;
  sessionId: string;
  sessionPurpose: string;
  sessionStatus: string;
  cameraId: string | null;
  kind: string;
  source: string;
  path: string;
  sizeBytes: number | null;
  durationMs: number | null;
  sha256: string | null;
  retentionTier: string;
  createdAt: string;
  syncedAt: string | null;
  metadata: Record<string, unknown> | null;
}

export function listDatasets(vehicleId?: string, limit = 100): Promise<DatasetAsset[]> {
  const params = new URLSearchParams();
  if (vehicleId) params.set("vehicleId", vehicleId);
  params.set("limit", String(limit));
  return request<DatasetAsset[]>("GET", `/api/v1/datasets?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Admin (c15) — all endpoints require role=ADMIN, otherwise 403 admin_required
// ---------------------------------------------------------------------------

export interface AdminAuditEvent {
  id: string;
  ts: string;
  eventName: string;
  actorId: string | null;
  targetType: string | null;
  targetId: string | null;
  payload: Record<string, unknown> | null;
}

export interface AdminDashboard {
  vehicleCount: number;
  userCount: number;
  recentAuditCount: number;
  recentEvents: AdminAuditEvent[];
}

export function getAdminDashboard(): Promise<AdminDashboard> {
  return request<AdminDashboard>("GET", "/api/v1/admin/dashboard");
}

// ---------------------------------------------------------------------------
// Admin (c15 P3) — vehicle CRUD + adapter registry + token / deploy package
// ---------------------------------------------------------------------------

export type VehicleTypeName =
  | "QUADRUPED"
  | "WHEELED"
  | "WHEELED_QUADRUPED"
  | "RC_CAR"
  | "DRONE"
  | "CUSTOM";

export interface AdminVehicle {
  id: string;
  vehicleId: string;
  displayName: string;
  vehicleType: VehicleTypeName;
  adapterType: string;
  platformId: string;
  cameraProfileId: string;
  audioProfileId: string;
  status: string;
  vendor: string | null;
  serialNumber: string | null;
  declaredCapabilities: string[];
  observedCapabilities: string[];
  maxLinearMs: number;
  maxAngularRads: number;
  createdBy: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  activeSessionCount: number;
  hasActiveLease: boolean;
  lastSeenAt: string | null;
}

export interface AdminVehicleDetail extends Omit<AdminVehicle, "activeSessionCount" | "hasActiveLease" | "lastSeenAt"> {
  createdByEmail: string | null;
  recentLeases: Array<{
    id: string;
    operatorEmail: string;
    status: string;
    createdAt: string;
    expiresAt: string;
    releasedAt: string | null;
    revokedAt: string | null;
  }>;
  recentSessions: Array<{
    sessionId: string;
    userEmail: string;
    purpose: string;
    status: string;
    createdAt: string;
    closedAt: string | null;
  }>;
}

export interface CreateVehicleInput {
  vehicleId: string;
  displayName: string;
  vehicleType: VehicleTypeName;
  adapterType: string;
  platformId: string;
  cameraProfileId: string;
  audioProfileId: string;
  vendor?: string;
  serialNumber?: string;
  declaredCapabilities?: string[];
  maxLinearMs?: number;
  maxAngularRads?: number;
}

export type UpdateVehicleInput = Partial<{
  displayName: string;
  vehicleType: VehicleTypeName;
  adapterType: string;
  platformId: string;
  cameraProfileId: string;
  audioProfileId: string;
  vendor: string | null;
  serialNumber: string | null;
  declaredCapabilities: string[];
  observedCapabilities: string[];
  maxLinearMs: number;
  maxAngularRads: number;
}>;

export interface AdapterTypeInfo {
  id: string;
  displayName: string;
  description: string;
  defaultCapabilities: string[];
  vehicleTypes: VehicleTypeName[];
}

export interface AdapterTypesResponse {
  adapterTypes: AdapterTypeInfo[];
  allCapabilities: string[];
}

export interface MintedVehicleToken {
  token: string;
  expiresAt: string;
  roomName: string;
  identity: string;
  url: string;
}

export function adminListVehicles(includeArchived = false): Promise<AdminVehicle[]> {
  const qs = includeArchived ? "?includeArchived=1" : "";
  return request<AdminVehicle[]>("GET", `/api/v1/admin/vehicles${qs}`);
}

export function adminCreateVehicle(input: CreateVehicleInput): Promise<AdminVehicle> {
  return request<AdminVehicle>("POST", "/api/v1/admin/vehicles", input);
}

export function adminGetVehicle(id: string): Promise<AdminVehicleDetail> {
  return request<AdminVehicleDetail>(
    "GET",
    `/api/v1/admin/vehicles/${encodeURIComponent(id)}`,
  );
}

export function adminUpdateVehicle(
  id: string,
  patch: UpdateVehicleInput,
): Promise<AdminVehicleDetail> {
  return request<AdminVehicleDetail>(
    "PATCH",
    `/api/v1/admin/vehicles/${encodeURIComponent(id)}`,
    patch,
  );
}

export function adminArchiveVehicle(id: string): Promise<AdminVehicleDetail> {
  return request<AdminVehicleDetail>(
    "DELETE",
    `/api/v1/admin/vehicles/${encodeURIComponent(id)}`,
  );
}

export function adminMintVehicleToken(
  id: string,
  opts: { ttlSeconds?: number; identity?: string } = {},
): Promise<MintedVehicleToken> {
  return request<MintedVehicleToken>(
    "POST",
    `/api/v1/admin/vehicles/${encodeURIComponent(id)}/token`,
    opts,
  );
}

/**
 * Download the deploy package (tar.gz) as a Blob — caller triggers the save
 * via URL.createObjectURL. Uses a raw fetch because the shared request()
 * helper is JSON-only.
 */
export async function adminDownloadDeployPackage(id: string): Promise<Blob> {
  const path = `/api/v1/admin/vehicles/${encodeURIComponent(id)}/deploy-package`;

  const doFetch = () =>
    fetch(`${API_BASE}${path}`, {
      credentials: "include",
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });

  let res = await doFetch();
  if (res.status === 401 && (await refresh())) {
    res = await doFetch();
  }
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as ApiResponse<never>;
    throw new ApiError(json.error ?? `http_${res.status}`, res.status, json);
  }
  return res.blob();
}

export function adminListAdapterTypes(): Promise<AdapterTypesResponse> {
  return request<AdapterTypesResponse>("GET", "/api/v1/admin/adapter-types");
}

// ---------------------------------------------------------------------------
// Admin (c15 P4) — user CRUD + password / invite management
// ---------------------------------------------------------------------------

export type RoleName = "ADMIN" | "OPERATOR" | "VIEWER";

export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  role: RoleName;
  invitePending: boolean;
  inviteExpiresAt: string | null;
  twoFactorEnabled: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  activePermissionCount: number;
  lastLoginAt: string | null;
}

export interface AdminUserDetail extends AdminUser {
  permissions: Array<{
    vehicleId: string;
    vehicleDisplayName: string;
    role: RoleName;
    priorityOverride: number | null;
    grantedBy: string | null;
  }>;
  recentAuditEvents: Array<{
    id: string;
    ts: string;
    eventName: string;
    targetType: string | null;
    targetId: string | null;
    payload: Record<string, unknown> | null;
  }>;
}

export interface CreateUserInput {
  email: string;
  displayName: string;
  role: RoleName;
  inviteMethod: "email" | "manual_password";
  manualPassword?: string;
  copyPermissionsFromUserId?: string;
}

/** Credentials are one-shot — only present on the create response. */
export interface CreateUserResult extends AdminUser {
  userId: string;
  inviteLink?: string;
  temporaryPassword?: string;
  warning?: "admin_role_granted";
}

export type UpdateUserInput = Partial<{
  email: string;
  displayName: string;
  role: RoleName;
  /** null = restore an archived user (archiving goes through adminArchiveUser). */
  archivedAt: null;
}>;

export interface ResetPasswordResult {
  userId: string;
  email: string;
  inviteLink?: string;
  temporaryPassword?: string;
}

export interface ResendInviteResult {
  userId: string;
  email: string;
  inviteLink: string;
  inviteExpiresAt: string;
}

export function adminListUsers(
  opts: { includeArchived?: boolean; role?: RoleName } = {},
): Promise<AdminUser[]> {
  const params = new URLSearchParams();
  if (opts.includeArchived) params.set("includeArchived", "1");
  if (opts.role) params.set("role", opts.role);
  const qs = params.toString();
  return request<AdminUser[]>("GET", `/api/v1/admin/users${qs ? `?${qs}` : ""}`);
}

export function adminCreateUser(input: CreateUserInput): Promise<CreateUserResult> {
  return request<CreateUserResult>("POST", "/api/v1/admin/users", input);
}

export function adminGetUser(id: string): Promise<AdminUserDetail> {
  return request<AdminUserDetail>(
    "GET",
    `/api/v1/admin/users/${encodeURIComponent(id)}`,
  );
}

export function adminUpdateUser(
  id: string,
  patch: UpdateUserInput,
): Promise<AdminUser> {
  return request<AdminUser>(
    "PATCH",
    `/api/v1/admin/users/${encodeURIComponent(id)}`,
    patch,
  );
}

export function adminArchiveUser(id: string): Promise<AdminUser> {
  return request<AdminUser>(
    "DELETE",
    `/api/v1/admin/users/${encodeURIComponent(id)}`,
  );
}

export function adminResetUserPassword(
  id: string,
  opts: { method: "invite_link" | "manual"; manualPassword?: string },
): Promise<ResetPasswordResult> {
  return request<ResetPasswordResult>(
    "POST",
    `/api/v1/admin/users/${encodeURIComponent(id)}/reset-password`,
    opts,
  );
}

export function adminResendInvite(id: string): Promise<ResendInviteResult> {
  return request<ResendInviteResult>(
    "POST",
    `/api/v1/admin/users/${encodeURIComponent(id)}/resend-invite`,
  );
}

/** Public endpoint — the invited user is not authenticated yet. */
export function acceptInvite(input: {
  inviteToken: string;
  newPassword: string;
}): Promise<{ email: string }> {
  return request<{ email: string }>("POST", "/api/v1/auth/accept-invite", input);
}

// ---------------------------------------------------------------------------
// Admin (c15 P5) — permission matrix (user × vehicle × role × priority)
// NOTE: vehicleId in these shapes is the internal Vehicle UUID (matches the
// PUT input + VehiclePermission FK); vehicleExternalId is the machine id
// (e.g. "amr-01") for display.
// ---------------------------------------------------------------------------

export interface AdminPermissionEntry {
  vehicleId: string;
  vehicleExternalId: string;
  vehicleDisplayName: string;
  vehicleStatus: string;
  role: RoleName;
  priorityOverride: number | null;
  grantedBy: string | null;
  grantedByEmail: string | null;
  updatedAt: string;
}

export interface AdminAvailableVehicle {
  vehicleId: string;
  vehicleExternalId: string;
  displayName: string;
  vehicleType: string;
  status: string;
}

export interface AdminUserPermissions {
  userId: string;
  userEmail: string;
  userDisplayName: string | null;
  userRole: RoleName;
  permissions: AdminPermissionEntry[];
  /** Non-archived vehicles the user has no permission for yet (add flow). */
  availableVehicles: AdminAvailableVehicle[];
}

/** One entry of the PUT full-replace array. */
export interface PermissionWrite {
  vehicleId: string;
  role: RoleName;
  /** null / omitted = role default (ADMIN 100 / OPERATOR 50 / VIEWER 0). */
  priorityOverride?: number | null;
}

export interface AdminMatrixUser {
  userId: string;
  email: string;
  displayName: string | null;
  role: RoleName;
}

export interface AdminMatrixPermission {
  userId: string;
  vehicleId: string;
  role: RoleName;
  priorityOverride: number | null;
  grantedBy: string | null;
}

export interface AdminPermissionMatrix {
  users: AdminMatrixUser[];
  vehicles: AdminAvailableVehicle[];
  permissions: AdminMatrixPermission[];
  totalUsers: number;
  limit: number;
  offset: number;
}

export function adminGetUserPermissions(userId: string): Promise<AdminUserPermissions> {
  return request<AdminUserPermissions>(
    "GET",
    `/api/v1/admin/permissions?userId=${encodeURIComponent(userId)}`,
  );
}

/** Full replace of one user's permissions (atomic on the backend). */
export function adminPutUserPermissions(
  userId: string,
  permissions: PermissionWrite[],
): Promise<AdminUserPermissions> {
  return request<AdminUserPermissions>("PUT", "/api/v1/admin/permissions", {
    userId,
    permissions,
  });
}

export function adminGetPermissionMatrix(
  opts: { limit?: number; offset?: number } = {},
): Promise<AdminPermissionMatrix> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return request<AdminPermissionMatrix>(
    "GET",
    `/api/v1/admin/permissions/matrix${qs ? `?${qs}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// Admin (c15 P6) — audit log viewer + CSV export
// ---------------------------------------------------------------------------

export type AuditImportance = "red" | "orange" | "default";
export type AuditCategory = "AUDIT" | "TELEMETRY" | "SYSTEM";

export interface AdminAuditEventDetail {
  id: string;
  ts: string;
  category: AuditCategory | null;
  eventName: string;
  actorId: string | null;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  payload: Record<string, unknown> | null;
  tenantId: string | null;
  importance: AuditImportance;
}

export interface AdminAuditQuery {
  since?: string; // ISO datetime
  until?: string;
  eventName?: string[]; // sent comma-separated
  category?: AuditCategory;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  limit?: number;
  cursor?: string;
}

export interface AdminAuditPage {
  events: AdminAuditEventDetail[];
  nextCursor: string | null;
}

function auditQueryString(q: AdminAuditQuery): string {
  const params = new URLSearchParams();
  if (q.since) params.set("since", q.since);
  if (q.until) params.set("until", q.until);
  if (q.eventName && q.eventName.length > 0) params.set("eventName", q.eventName.join(","));
  if (q.category) params.set("category", q.category);
  if (q.actorId) params.set("actorId", q.actorId);
  if (q.targetType) params.set("targetType", q.targetType);
  if (q.targetId) params.set("targetId", q.targetId);
  if (q.limit !== undefined) params.set("limit", String(q.limit));
  if (q.cursor) params.set("cursor", q.cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function adminListAudit(q: AdminAuditQuery = {}): Promise<AdminAuditPage> {
  return request<AdminAuditPage>("GET", `/api/v1/admin/audit${auditQueryString(q)}`);
}

/**
 * CSV export as a Blob — caller triggers the save via URL.createObjectURL.
 * Raw fetch because the shared request() helper is JSON-only.
 * Server hard-caps at 10,000 rows (400 export_too_large beyond).
 */
export async function adminExportAuditCsv(q: AdminAuditQuery = {}): Promise<Blob> {
  const { limit: _limit, cursor: _cursor, ...filters } = q;
  const path = `/api/v1/admin/audit/export${auditQueryString(filters)}`;

  const doFetch = () =>
    fetch(`${API_BASE}${path}`, {
      credentials: "include",
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });

  let res = await doFetch();
  if (res.status === 401 && (await refresh())) {
    res = await doFetch();
  }
  if (!res.ok) {
    const json = (await res.json().catch(() => ({}))) as ApiResponse<never>;
    throw new ApiError(json.error ?? `http_${res.status}`, res.status, json);
  }
  return res.blob();
}

// ---------------------------------------------------------------------------
// Livekit token
// ---------------------------------------------------------------------------

export interface LivekitTokenResponse {
  token: string;
  url: string;
  roomName: string;
  identity: string;
  expiresAt: string;
}

export function getLivekitToken(
  vehicleId: string,
  role: "operator" | "viewer" | "admin",
): Promise<LivekitTokenResponse> {
  return request<LivekitTokenResponse>("POST", "/api/v1/livekit/token", { vehicleId, role });
}
