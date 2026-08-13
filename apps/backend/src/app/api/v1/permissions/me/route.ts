import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getAuthContext } from "@/lib/auth-context";
import { ok, fail } from "@/lib/api-response";
import { AppError } from "@/lib/errors";

export async function GET(request: NextRequest) {
  try {
    const ctx = await getAuthContext(request);

    // Fetch profile + per-vehicle permissions for this user.
    // email/displayName power the admin shell user menu (c15 P2).
    const [user, vehiclePermissions] = await Promise.all([
      prisma.user.findUnique({
        where: { id: ctx.userId },
        select: { email: true, displayName: true },
      }),
      prisma.vehiclePermission.findMany({
        where: { userId: ctx.userId },
        select: { vehicleId: true, role: true },
      }),
    ]);

    return ok({
      userId: ctx.userId,
      email: user?.email ?? null,
      displayName: user?.displayName ?? null,
      role: ctx.role,
      vehiclePermissions: vehiclePermissions.map((p) => ({
        vehicleId: p.vehicleId,
        role: p.role,
      })),
    });
  } catch (err) {
    if (err instanceof AppError) {
      return fail(err.code, err.status, err.extra);
    }
    console.error("[permissions/me]", err);
    return fail("internal_error", 500);
  }
}
