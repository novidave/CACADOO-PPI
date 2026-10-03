import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/** POST only, so a link or image on another site cannot log people out. */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  await supabase?.auth.signOut();
  return NextResponse.redirect(new URL("/", request.nextUrl.origin), { status: 303 });
}
