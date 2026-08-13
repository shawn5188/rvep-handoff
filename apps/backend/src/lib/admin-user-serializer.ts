import { User } from "@prisma/client";
import { Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { NotFound } from "@/lib/errors";

/**
 * c15 P4 — wire shape + lookup helpers for admin user responses.
 *
 * SECURITY: serializeUser deliberately excludes passwordHash, twoFactorSecret
 * AND inviteToken. The invite token grants account takeover, so it is only
 * ever surfaced as a one-shot inviteLink in the create / reset / resend
 * responses — never in list / detail reads.
 */

export async function findUserOr404(id: string): Promise<User> {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new NotFound("user_not_found");
  return user;
}

export function serializeUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    invitePending: u.invitePending,
    inviteExpiresAt: u.inviteExpiresAt ? u.inviteExpiresAt.toISOString() : null,
    twoFactorEnabled: u.twoFactorEnabled,
    failedLoginCount: u.failedLoginCount,
    lockedUntil: u.lockedUntil ? u.lockedUntil.toISOString() : null,
    archivedAt: u.archivedAt ? u.archivedAt.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

export type SerializedUser = ReturnType<typeof serializeUser>;

/** Invite links stay valid for 72 h (per c15 P4 spec). */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000;

export function inviteExpiry(now = Date.now()): Date {
  return new Date(now + INVITE_TTL_MS);
}

/**
 * Absolute accept-invite URL. Base from INVITE_LINK_BASE_URL
 * (e.g. https://ops.example.com/accept-invite); falls back to the web app
 * origin (CORS_ALLOWED_ORIGIN, default localhost:3011) + /accept-invite.
 */
export function buildInviteLink(token: string): string {
  const base =
    process.env.INVITE_LINK_BASE_URL ??
    `${process.env.CORS_ALLOWED_ORIGIN ?? "http://localhost:3011"}/accept-invite`;
  return `${base}?token=${encodeURIComponent(token)}`;
}

/**
 * Count non-archived ADMIN users, optionally excluding one user — the
 * "at least 1 active admin" red line shared by archive + role-demote paths.
 */
export function countActiveAdmins(excludeUserId?: string): Promise<number> {
  return prisma.user.count({
    where: {
      role: Role.ADMIN,
      archivedAt: null,
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
    },
  });
}

/** Latest successful-login timestamps keyed by userId (from EventLog). */
export async function lastLoginByUserId(): Promise<Map<string, Date>> {
  const rows = await prisma.eventLog.groupBy({
    by: ["userId"],
    where: { eventName: "login_success", userId: { not: null } },
    _max: { ts: true },
  });
  const map = new Map<string, Date>();
  for (const row of rows) {
    if (row.userId && row._max.ts) map.set(row.userId, row._max.ts);
  }
  return map;
}
