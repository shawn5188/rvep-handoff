import { prisma } from "@/lib/db";
import { ok } from "@/lib/api-response";
import { Conflict } from "@/lib/errors";
import { withAdmin } from "@/middleware/require-admin";
import { logAudit } from "@/lib/audit";
import {
  buildInviteLink,
  findUserOr404,
  inviteExpiry,
} from "@/lib/admin-user-serializer";
import { generateInviteToken } from "@/lib/password";

/**
 * c15 P4 — POST /api/v1/admin/users/:id/resend-invite
 * Re-sign the invite token + extend expiry 72 h. Only valid while the user is
 * still invitePending (otherwise 409 invite_not_pending — use reset-password
 * with method=invite_link to restart the flow for an active user).
 */

type Ctx = { params: Promise<{ id: string }> };

export const POST = withAdmin<Ctx>(async (_request, auth, context) => {
  const { id } = await context.params;
  const user = await findUserOr404(id);

  if (user.archivedAt) {
    throw new Conflict("user_archived", {
      archivedAt: user.archivedAt.toISOString(),
    });
  }
  if (!user.invitePending) {
    throw new Conflict("invite_not_pending");
  }

  const inviteToken = generateInviteToken();
  const expiresAt = inviteExpiry();
  await prisma.user.update({
    where: { id: user.id },
    data: { inviteToken, inviteExpiresAt: expiresAt },
  });

  await logAudit({
    actorId: auth.userId,
    eventName: "user_invite_resent",
    targetType: "User",
    targetId: user.id,
    payload: { email: user.email },
  });

  return ok({
    userId: user.id,
    email: user.email,
    inviteLink: buildInviteLink(inviteToken),
    inviteExpiresAt: expiresAt.toISOString(),
  });
});
