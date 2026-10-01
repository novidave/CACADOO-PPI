import { NextResponse, type NextRequest } from "next/server";
import { defaultLocale, isLocale, LOCALE_COOKIE, type Locale } from "@/i18n/config";
import { refreshSession } from "@/lib/supabase/session";

const ONE_YEAR = 60 * 60 * 24 * 365;

function preferredLocale(request: NextRequest): Locale {
  const saved = request.cookies.get(LOCALE_COOKIE)?.value;
  if (isLocale(saved)) return saved;

  const header = request.headers.get("accept-language") ?? "";
  for (const part of header.split(",")) {
    const code = part.split(";")[0].trim().slice(0, 2).toLowerCase();
    if (isLocale(code)) return code;
  }
  return defaultLocale;
}

/** Every page lives under /sk, /hu or /en. Remembers the chosen language. */
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const segment = pathname.split("/")[1];

  if (!isLocale(segment)) {
    const url = request.nextUrl.clone();
    url.pathname = `/${preferredLocale(request)}${pathname === "/" ? "" : pathname}`;
    return NextResponse.redirect(url);
  }

  const response = NextResponse.next();
  if (request.cookies.get(LOCALE_COOKIE)?.value !== segment) {
    response.cookies.set(LOCALE_COOKIE, segment, { path: "/", maxAge: ONE_YEAR, sameSite: "lax" });
  }
  return refreshSession(request, response);
}

export const config = {
  // Skip Next internals, API/MCP routes and files with an extension (robots.txt, sitemap.xml, llms.txt...).
  matcher: ["/((?!_next/|api/|mcp|auth/|.*\\..*).*)"],
};
