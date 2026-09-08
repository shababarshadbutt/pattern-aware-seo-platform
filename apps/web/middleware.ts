import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * Deployment stopgap, not the real auth ADR-0026 defers: HTTP Basic Auth in
 * front of the whole web app, mirroring `apps/api/src/basic-auth.ts`.
 *
 * Every screen here talks to the API only from the server (Server Components,
 * Server Actions, route handlers proxying `WEB_API_URL` — see `lib/api.ts`),
 * so gating the browser's entry to this app is what actually closes the
 * front door; the API's own Basic Auth hook is what stops something other
 * than this app from reaching it directly.
 *
 * Off entirely when `BASIC_AUTH_USER`/`BASIC_AUTH_PASSWORD` are unset, which
 * is the case for local dev and for a deployment sitting behind its own
 * VPN/private network instead.
 */
export function middleware(request: NextRequest): NextResponse {
  const user = process.env.BASIC_AUTH_USER;
  const password = process.env.BASIC_AUTH_PASSWORD;

  if (user === undefined || password === undefined) {
    return NextResponse.next();
  }

  const header = request.headers.get("authorization");
  // `btoa`/`atob`, not `Buffer`, so this runs the same under the Edge runtime
  // middleware defaults to as it would under Node.
  const expected = `Basic ${btoa(`${user}:${password}`)}`;

  if (header === expected) {
    return NextResponse.next();
  }

  return new NextResponse("Unauthorized", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="pattern-aware-seo-platform"' }
  });
}

export const config = {
  // Everything except Next's own static asset/internal paths — a login
  // prompt on a favicon request is just noise, not a security boundary.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
