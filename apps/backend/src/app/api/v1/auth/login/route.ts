import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import {
  comparePassword,
  issueTokenPair,
  REFRESH_COOKIE_NAME,
  refreshCookieOptions,
} from "@/lib/auth";
import { audit } from "@/lib/audit";
import { validateBody } from "@/lib/validation";
import { loginSchema } from "@/lib/zod-schemas/auth";
import { ok, fail } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { User } from "@prisma/client";

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Record a failed login attempt.
 * If the account was previously locked but the lock has expired,
 * reset the counter to 1 instead of continuing to increment.
 */
async function recordLoginFailure(user: User): Promise<void> {
  const wasLocked =
    user.lockedUntil !== null && user.lockedUntil <= new Date();

  // If lock expired, start fresh from 1; otherwise keep incrementing.
  const newFailCount = wasLocked ? 1 : user.failedLoginCount + 1;
  const shouldLock = newFailCount >= MAX_FAILED_ATTEMPTS;
  const lockedUntil = shouldLock ? new Date(Date.now() + LOCK_DURATION_MS) : null;

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: newFailCount,
      // Clear expired lock when resetting, set new lock when threshold hit.
      lockedUntil: wasLocked ? lockedUntil : shouldLock ? lockedUntil : undefined,
    },
  });

  if (shouldLock) {
    await audit({
      eventName: "account_locked",
      userId: user.id,
      payload: { failedAttempts: newFailCount, lockedUntil },
    });
  }

  await audit({
    eventName: "login_failed",
    userId: user.id,
    payload: { failedAttempts: newFailCount },
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await validateBody(request, loginSchema);

    // 1. Find user.
    const user = await prisma.user.findUnique({
      where: { email: body.email },
    });

    // Constant-time response: same error for unknown email vs wrong password.
    // Archived (soft-deleted, c15 P4) users are indistinguishable from
    // unknown ones — archive must actually revoke access.
    if (!user || user.archivedAt !== null) {
      return fail("invalid_credentials", 401);
    }

    // 2. Check if account is actively locked.
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await audit({
        eventName: "account_locked",
        userId: user.id,
        payload: { reason: "login_attempt_while_locked", email: body.email },
      });
      return fail("account_locked", 423);
    }

    // 3. Verify password.
    const passwordValid = await comparePassword(body.password, user.passwordHash);

    if (!passwordValid) {
      await recordLoginFailure(user);
      return fail("invalid_credentials", 401);
    }

    // 4. Successful login: increment refreshTokenVersion, reset failure state, issue tokens.
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: 0,
        lockedUntil: null,
        refreshTokenVersion: { increment: 1 },
      },
    });

    const tokens = await issueTokenPair(
      user.id,
      user.role,
      updated.refreshTokenVersion,
    );

    await audit({
      eventName: "login_success",
      userId: user.id,
      payload: { email: body.email },
    });

    // 5. Build response with refresh token cookie.
    const response = ok(
      {
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt.toISOString(),
        role: user.role,
      },
      200,
    );

    response.cookies.set(REFRESH_COOKIE_NAME, tokens.refreshToken, refreshCookieOptions());

    return response;
  } catch (err) {
    if (err instanceof AppError) {
      return fail(err.code, err.status, err.extra);
    }
    console.error("[auth/login]", err);
    return fail("internal_error", 500);
  }
}
