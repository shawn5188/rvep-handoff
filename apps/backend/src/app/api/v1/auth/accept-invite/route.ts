import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ok, fail } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { validateBody } from "@/lib/validation";
import { logAudit } from "@/lib/audit";
import { acceptInviteSchema } from "@/lib/admin-user-schemas";
import { hashPassword, validatePasswordPolicy } from "@/lib/password";

/**
 * c15 P4 — POST /api/v1/auth/accept-invite (PUBLIC — no JWT; listed in
 * middleware PUBLIC_PATHS). The invited user follows the emailed link and
 * sets their own password; the admin never sees it (per SEC expert input).
 *
 * Body: { inviteToken, newPassword }
 *
 * Same 400 invalid_invite_token for unknown / consumed / archived-user tokens
 * so the endpoint cannot be used as an account oracle. invite_expired is
 * distinguishable — the token was legitimately theirs, they just need a
 * re-send from the admin.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await validateBody(request, acceptInviteSchema);

    const user = await prisma.user.findUnique({
      where: { inviteToken: body.inviteToken },
    });
    if (!user || !user.invitePending || user.archivedAt !== null) {
      return fail("invalid_invite_token", 400);
    }
    if (!user.inviteExpiresAt || user.inviteExpiresAt <= new Date()) {
      return fail("invite_expired", 400);
    }

    const policy = validatePasswordPolicy(body.newPassword);
    if (!policy.ok) {
      return fail("weak_password", 422, { reason: policy.reason });
    }

    const passwordHash = await hashPassword(body.newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        invitePending: false,
        inviteToken: null,
        inviteExpiresAt: null,
        // Invalidate anything issued against the placeholder credential.
        refreshTokenVersion: { increment: 1 },
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    await logAudit({
      actorId: user.id,
      eventName: "user_invite_accepted",
      targetType: "User",
      targetId: user.id,
      payload: { email: user.email },
    });

    return ok({ email: user.email });
  } catch (err) {
    if (err instanceof AppError) {
      return fail(err.code, err.status, err.extra);
    }
    console.error("[auth/accept-invite]", err);
    return fail("internal_error", 500);
  }
}
