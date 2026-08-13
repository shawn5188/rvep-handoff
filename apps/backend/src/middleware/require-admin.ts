import { NextRequest } from "next/server";
import { Role } from "@prisma/client";
import { getAuthContext, AuthContext } from "@/lib/auth-context";
import { fail } from "@/lib/api-response";
import { AppError } from "@/lib/errors";
import { logAudit } from "@/lib/audit";

/**
 * c15 P2 — ADMIN role gate for all /api/v1/admin/* route handlers.
 *
 * The global JWT middleware (src/middleware.ts) already authenticates every
 * /api/v1/* request and injects x-user-id / x-user-role. This wrapper adds:
 *   1. role === ADMIN check (403 `admin_required` otherwise)
 *   2. an AUDIT EventLog row for every admin API call (method + path + actor)
 *   3. unified AppError → HTTP mapping so handlers can just throw
 *
 * Usage (P3-P7 must follow this pattern):
 *
 *   export const GET = withAdmin(async (request, auth) => {
 *     // auth.userId is the acting admin — use for createdBy / grantedBy
 *     return ok({ ... });
 *   });
 *
 *   // dynamic segments:
 *   export const PATCH = withAdmin<{ params: Promise<{ id: string }> }>(
 *     async (request, auth, context) => {
 *       const { id } = await context.params;
 *       ...
 *     },
 *   );
 */

export type AdminHandler<Ctx> = (
  request: NextRequest,
  auth: AuthContext,
  context: Ctx,
) => Promise<Response> | Response;

export function withAdmin<Ctx = unknown>(
  handler: AdminHandler<Ctx>,
): (request: NextRequest, context: Ctx) => Promise<Response> {
  return async (request: NextRequest, context: Ctx): Promise<Response> => {
    const method = request.method;
    const path = new URL(request.url).pathname;

    let auth: AuthContext;
    try {
      auth = await getAuthContext(request);
    } catch (err) {
      if (err instanceof AppError) return fail(err.code, err.status, err.extra);
      return fail("unauthenticated", 401);
    }

    if (auth.role !== Role.ADMIN) {
      // Denied attempts are security-relevant — record them too.
      await logAudit({
        actorId: auth.userId,
        eventName: "admin_api_denied",
        payload: { method, path, role: auth.role },
      });
      return fail("admin_required", 403);
    }

    await logAudit({
      actorId: auth.userId,
      eventName: "admin_api_access",
      payload: { method, path },
    });

    try {
      return await handler(request, auth, context);
    } catch (err) {
      if (err instanceof AppError) return fail(err.code, err.status, err.extra);
      console.error(`[admin] ${method} ${path}`, err);
      return fail("internal_error", 500);
    }
  };
}
