import { NextRequest, NextResponse } from "next/server";
import { verifyAccessToken } from "@/lib/auth";

/**
 * Middleware: JWT authentication for all /api/v1/* routes.
 *
 * Public paths (no token required):
 *   - POST /api/v1/auth/login
 *   - POST /api/v1/auth/refresh
 *   - POST /api/v1/auth/accept-invite  (c15 P4 — invited user has no JWT yet)
 *
 * For protected paths:
 *   1. Extract Bearer token from Authorization header.
 *   2. Verify with HS256 using JWT_SIGNING_KEY.
 *   3. Inject x-user-id + x-user-role into request headers for downstream handlers.
 *   4. Return 401 on failure.
 */

const PUBLIC_PATHS = new Set([
  "/api/v1/auth/login",
  "/api/v1/auth/refresh",
  "/api/v1/auth/accept-invite",
]);

// Internal endpoints authenticate via x-internal-token, not user JWT.
const INTERNAL_PREFIX = "/api/v1/internal/";

const CORS_ALLOWED_ORIGIN = process.env.CORS_ALLOWED_ORIGIN ?? "http://localhost:3011";

function applyCors(res: NextResponse, origin: string | null): NextResponse {
  // Allow the configured web origin + localhost (any port) + RFC1918 private LAN
  // ranges (so LAN devices like iPhone/iPad/partner laptops can demo).
  const isLanOrigin = origin !== null && (
    origin.startsWith("http://localhost") ||
    origin.startsWith("http://127.") ||
    /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(origin) ||
    /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(origin) ||
    /^https?:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}(:\d+)?$/.test(origin)
  );
  const allow = origin && (origin === CORS_ALLOWED_ORIGIN || isLanOrigin)
    ? origin
    : CORS_ALLOWED_ORIGIN;
  res.headers.set("Access-Control-Allow-Origin", allow);
  res.headers.set("Access-Control-Allow-Credentials", "true");
  res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.headers.set("Vary", "Origin");
  return res;
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  const origin = request.headers.get("origin");

  // CORS pre-flight.
  if (request.method === "OPTIONS") {
    return applyCors(new NextResponse(null, { status: 204 }), origin);
  }

  // Pass through public auth endpoints (still apply CORS so browser can read cookie).
  if (PUBLIC_PATHS.has(pathname)) {
    return applyCors(NextResponse.next(), origin);
  }

  // Internal endpoints: skip user JWT; route handler verifies x-internal-token itself.
  if (pathname.startsWith(INTERNAL_PREFIX)) {
    return NextResponse.next();
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return applyCors(NextResponse.json({ error: "unauthenticated" }, { status: 401 }), origin);
  }

  const token = authHeader.slice(7);
  try {
    const payload = await verifyAccessToken(token);

    // Clone request headers and inject auth context.
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-user-id", payload.sub);
    requestHeaders.set("x-user-role", payload.role);

    return applyCors(
      NextResponse.next({ request: { headers: requestHeaders } }),
      origin,
    );
  } catch {
    return applyCors(NextResponse.json({ error: "unauthenticated" }, { status: 401 }), origin);
  }
}

export const config = {
  matcher: ["/api/v1/:path*"],
};
