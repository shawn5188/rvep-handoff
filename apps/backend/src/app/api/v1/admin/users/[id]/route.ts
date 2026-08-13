import { Prisma, Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { ok } from "@/lib/api-response";
import { AppError, Conflict, UnprocessableEntity } from "@/lib/errors";
import { withAdmin } from "@/middleware/require-admin";
import { logAudit } from "@/lib/audit";
import { updateUserSchema } from "@/lib/admin-user-schemas";
import {
  countActiveAdmins,
  findUserOr404,
  serializeUser,
} from "@/lib/admin-user-serializer";

/**
 * c15 P4 — single user admin resource. `[id]` = User.id (uuid).
 *
 * GET    — detail + vehicle-permission summary + latest 5 audit events where
 *          this user is the actor.
 * PATCH  — partial update (email / displayName / role / archivedAt=null
 *          restore). Role + email changes get dedicated audit events.
 * DELETE — soft archive. Red lines: cannot archive self; at least one active
 *          ADMIN must remain. Sessions are revoked via refreshTokenVersion.
 */

type Ctx = { params: Promise<{ id: string }> };

export const GET = withAdmin<Ctx>(async (_request, _auth, context) => {
  const { id } = await context.params;
  const user = await findUserOr404(id);

  const [permissions, recentAudit, lastLogin] = await Promise.all([
    prisma.vehiclePermission.findMany({
      where: { userId: user.id },
      include: {
        vehicle: { select: { vehicleId: true, displayName: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.eventLog.findMany({
      where: { actorId: user.id },
      orderBy: { ts: "desc" },
      take: 5,
    }),
    prisma.eventLog.findFirst({
      where: { eventName: "login_success", userId: user.id },
      orderBy: { ts: "desc" },
      select: { ts: true },
    }),
  ]);

  return ok({
    ...serializeUser(user),
    lastLoginAt: lastLogin?.ts.toISOString() ?? null,
    activePermissionCount: permissions.length,
    permissions: permissions.map((p) => ({
      vehicleId: p.vehicle.vehicleId,
      vehicleDisplayName: p.vehicle.displayName,
      role: p.role,
      priorityOverride: p.priorityOverride,
      grantedBy: p.grantedBy,
    })),
    recentAuditEvents: recentAudit.map((e) => ({
      id: e.id.toString(),
      ts: e.ts.toISOString(),
      eventName: e.eventName,
      targetType: e.targetType,
      targetId: e.targetId,
      payload: (e.payload as Record<string, unknown> | null) ?? null,
    })),
  });
});

export const PATCH = withAdmin<Ctx>(async (request, auth, context) => {
  const { id } = await context.params;
  const user = await findUserOr404(id);

  const parsed = updateUserSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new UnprocessableEntity("validation_error", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const patch = parsed.data;

  const emailChanged = patch.email !== undefined && patch.email !== user.email;
  const roleChanged = patch.role !== undefined && patch.role !== user.role;
  const nameChanged =
    patch.displayName !== undefined && patch.displayName !== user.displayName;
  const restoring = patch.archivedAt === null && user.archivedAt !== null;

  if (!emailChanged && !roleChanged && !nameChanged && !restoring) {
    return ok(serializeUser(user));
  }

  // Red line: demoting the last active ADMIN would lock everyone out.
  if (
    roleChanged &&
    user.role === Role.ADMIN &&
    user.archivedAt === null &&
    (await countActiveAdmins(user.id)) === 0
  ) {
    throw new AppError("last_admin_protected", 400);
  }

  if (emailChanged) {
    const taken = await prisma.user.findUnique({
      where: { email: patch.email! },
      select: { id: true },
    });
    if (taken) throw new Conflict("email_taken", { email: patch.email });
  }

  let updated;
  try {
    updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(emailChanged ? { email: patch.email } : {}),
        ...(nameChanged ? { displayName: patch.displayName } : {}),
        ...(roleChanged ? { role: patch.role } : {}),
        ...(restoring ? { archivedAt: null } : {}),
      },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new Conflict("email_taken", { email: patch.email });
    }
    throw err;
  }

  // Dedicated audit events per security-relevant change (per c15 spec).
  if (roleChanged) {
    await logAudit({
      actorId: auth.userId,
      eventName: "user_role_changed",
      targetType: "User",
      targetId: user.id,
      payload: { email: updated.email, from: user.role, to: updated.role },
    });
  }
  if (emailChanged) {
    await logAudit({
      actorId: auth.userId,
      eventName: "user_email_changed",
      targetType: "User",
      targetId: user.id,
      payload: { from: user.email, to: updated.email },
    });
  }
  if (nameChanged) {
    await logAudit({
      actorId: auth.userId,
      eventName: "user_updated",
      targetType: "User",
      targetId: user.id,
      payload: {
        diff: { displayName: { from: user.displayName, to: updated.displayName } },
      },
    });
  }
  if (restoring) {
    await logAudit({
      actorId: auth.userId,
      eventName: "user_restored",
      targetType: "User",
      targetId: user.id,
      payload: { email: updated.email },
    });
  }

  return ok(serializeUser(updated));
});

export const DELETE = withAdmin<Ctx>(async (_request, auth, context) => {
  const { id } = await context.params;
  const user = await findUserOr404(id);

  // Red line 1: an admin must not lock themselves out mid-session.
  if (user.id === auth.userId) {
    throw new AppError("cannot_archive_self", 400);
  }

  if (user.archivedAt) {
    throw new Conflict("user_already_archived", {
      archivedAt: user.archivedAt.toISOString(),
    });
  }

  // Red line 2: at least one active ADMIN must remain after the archive.
  if (user.role === Role.ADMIN && (await countActiveAdmins(user.id)) === 0) {
    throw new AppError("last_admin_protected", 400);
  }

  const archived = await prisma.user.update({
    where: { id: user.id },
    data: {
      archivedAt: new Date(),
      // Invalidate refresh tokens so archived users cannot silently renew.
      refreshTokenVersion: { increment: 1 },
    },
  });

  await logAudit({
    actorId: auth.userId,
    eventName: "user_archived",
    targetType: "User",
    targetId: user.id,
    payload: { email: user.email, role: user.role },
  });

  return ok(serializeUser(archived));
});
