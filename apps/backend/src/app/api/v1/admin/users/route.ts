import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok } from "@/lib/api-response";
import { Conflict, UnprocessableEntity } from "@/lib/errors";
import { withAdmin } from "@/middleware/require-admin";
import { logAudit } from "@/lib/audit";
import { createUserSchema } from "@/lib/admin-user-schemas";
import {
  buildInviteLink,
  inviteExpiry,
  lastLoginByUserId,
  serializeUser,
} from "@/lib/admin-user-serializer";
import {
  generateInviteToken,
  hashPassword,
  validatePasswordPolicy,
} from "@/lib/password";

/**
 * c15 P4 — admin user collection.
 *
 * GET  /api/v1/admin/users[?includeArchived=1][&role=ADMIN]
 *   All users + activePermissionCount / lastLoginAt stats. Never returns
 *   passwordHash / twoFactorSecret / inviteToken.
 *
 * POST /api/v1/admin/users
 *   Create a user via invite link (email) or admin-set temp password
 *   (manual_password). 409 email_taken on duplicate.
 */

function isRoleName(value: string): value is Role {
  return value === "ADMIN" || value === "OPERATOR" || value === "VIEWER";
}

export const GET = withAdmin(async (request) => {
  const params = new URL(request.url).searchParams;
  const includeArchived = params.get("includeArchived") === "1";
  const roleParam = params.get("role");
  if (roleParam !== null && !isRoleName(roleParam)) {
    throw new UnprocessableEntity("invalid_role_filter", { role: roleParam });
  }

  const [users, permissionCounts, lastLogins] = await Promise.all([
    prisma.user.findMany({
      where: {
        ...(includeArchived ? {} : { archivedAt: null }),
        ...(roleParam ? { role: roleParam } : {}),
      },
      orderBy: { email: "asc" },
    }),
    prisma.vehiclePermission.groupBy({
      by: ["userId"],
      _count: { _all: true },
    }),
    lastLoginByUserId(),
  ]);

  const permissionsByUserId = new Map(
    permissionCounts.map((p) => [p.userId, p._count._all]),
  );

  return ok(
    users.map((u) => ({
      ...serializeUser(u),
      activePermissionCount: permissionsByUserId.get(u.id) ?? 0,
      lastLoginAt: lastLogins.get(u.id)?.toISOString() ?? null,
    })),
  );
});

export const POST = withAdmin(async (request, auth) => {
  const parsed = createUserSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new UnprocessableEntity("validation_error", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const input = parsed.data;

  if (input.inviteMethod === "manual_password") {
    const policy = validatePasswordPolicy(input.manualPassword!);
    if (!policy.ok) {
      throw new UnprocessableEntity("weak_password", { reason: policy.reason });
    }
  }

  // Wizard shortcut: clone another user's vehicle permissions on create.
  let copiedPermissions: Array<{
    vehicleId: string;
    role: Role;
    priorityOverride: number | null;
  }> = [];
  if (input.copyPermissionsFromUserId) {
    const source = await prisma.user.findUnique({
      where: { id: input.copyPermissionsFromUserId },
      include: { vehiclePermissions: true },
    });
    if (!source) {
      throw new UnprocessableEntity("copy_source_not_found", {
        userId: input.copyPermissionsFromUserId,
      });
    }
    copiedPermissions = source.vehiclePermissions.map((p) => ({
      vehicleId: p.vehicleId,
      role: p.role,
      priorityOverride: p.priorityOverride,
    }));
  }

  // Pre-check the common duplicate case; P2002 catch covers the race
  // (pglite test gateway drops the connection on constraint violations).
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (existing) {
    throw new Conflict("email_taken", { email: input.email });
  }

  const isManual = input.inviteMethod === "manual_password";
  const inviteToken = isManual ? null : generateInviteToken();
  // Invite users get an unguessable random placeholder hash — the account is
  // unusable until accept-invite sets a real password.
  const passwordHash = await hashPassword(
    isManual ? input.manualPassword! : generateInviteToken(),
  );

  let user;
  try {
    user = await prisma.user.create({
      data: {
        email: input.email,
        displayName: input.displayName,
        role: input.role,
        passwordHash,
        invitePending: !isManual,
        inviteToken,
        inviteExpiresAt: isManual ? null : inviteExpiry(),
        ...(copiedPermissions.length > 0
          ? {
              vehiclePermissions: {
                create: copiedPermissions.map((p) => ({
                  vehicleId: p.vehicleId,
                  role: p.role,
                  priorityOverride: p.priorityOverride,
                  grantedBy: auth.userId,
                })),
              },
            }
          : {}),
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new Conflict("email_taken", { email: input.email });
    }
    throw err;
  }

  await logAudit({
    actorId: auth.userId,
    eventName: "user_created",
    targetType: "User",
    targetId: user.id,
    payload: {
      email: user.email,
      role: user.role,
      inviteMethod: input.inviteMethod,
      ...(input.copyPermissionsFromUserId
        ? {
            copiedPermissionsFromUserId: input.copyPermissionsFromUserId,
            copiedPermissionCount: copiedPermissions.length,
          }
        : {}),
    },
  });

  return ok(
    {
      ...serializeUser(user),
      userId: user.id,
      activePermissionCount: copiedPermissions.length,
      lastLoginAt: null,
      // Credentials are shown exactly once — never readable again via API.
      ...(isManual
        ? { temporaryPassword: input.manualPassword! }
        : { inviteLink: buildInviteLink(inviteToken!) }),
      // Granting another ADMIN is legal (admins may add peers) but flagged so
      // the UI shows a warning banner.
      ...(user.role === Role.ADMIN ? { warning: "admin_role_granted" } : {}),
    },
    201,
  );
});
