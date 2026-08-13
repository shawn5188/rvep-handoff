import { prisma } from "@/lib/db";
import { ok } from "@/lib/api-response";
import { Conflict, UnprocessableEntity } from "@/lib/errors";
import { withAdmin } from "@/middleware/require-admin";
import { logAudit } from "@/lib/audit";
import { resetPasswordSchema } from "@/lib/admin-user-schemas";
import {
  buildInviteLink,
  findUserOr404,
  inviteExpiry,
} from "@/lib/admin-user-serializer";
import {
  generateInviteToken,
  hashPassword,
  validatePasswordPolicy,
} from "@/lib/password";

/**
 * c15 P4 — POST /api/v1/admin/users/:id/reset-password
 *
 * method=manual       → admin sets a temp password (policy-checked), returned
 *                       once as temporaryPassword.
 * method=invite_link  → re-issue an invite token; the user sets their own
 *                       password via /accept-invite.
 *
 * Either way refreshTokenVersion is bumped so existing sessions cannot renew,
 * and the lockout state is cleared (admin reset = trusted unlock).
 */

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAdmin<Ctx>(async (request, auth, context) => {
  const { id } = await context.params;
  const user = await findUserOr404(id);

  if (user.archivedAt) {
    throw new Conflict("user_archived", {
      archivedAt: user.archivedAt.toISOString(),
    });
  }

  const parsed = resetPasswordSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    throw new UnprocessableEntity("validation_error", {
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const input = parsed.data;

  let responseExtra: Record<string, string>;

  if (input.method === "manual") {
    const policy = validatePasswordPolicy(input.manualPassword!);
    if (!policy.ok) {
      throw new UnprocessableEntity("weak_password", { reason: policy.reason });
    }
    const passwordHash = await hashPassword(input.manualPassword!);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        invitePending: false,
        inviteToken: null,
        inviteExpiresAt: null,
        refreshTokenVersion: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    responseExtra = { temporaryPassword: input.manualPassword! };
  } else {
    const inviteToken = generateInviteToken();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        inviteToken,
        inviteExpiresAt: inviteExpiry(),
        invitePending: true,
        refreshTokenVersion: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });
    responseExtra = { inviteLink: buildInviteLink(inviteToken) };
  }

  await logAudit({
    actorId: auth.userId,
    eventName: "user_password_reset",
    targetType: "User",
    targetId: user.id,
    payload: { email: user.email, method: input.method },
  });

  return ok({ userId: user.id, email: user.email, ...responseExtra });
});
