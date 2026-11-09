import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/data";

// Issues a 60-second signed link to a private attachment. Storage policies (workspace
// membership on the first path segment) decide whether the signed-in user may read it.
export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get("path") ?? "";
  if (!/^[0-9a-f-]{36}\/[^\\]+$/i.test(path) || path.includes("..")) {
    return new NextResponse("Invalid attachment path", { status: 400 });
  }
  const db = await getDb();
  if (!db) return NextResponse.redirect(new URL("/login", request.nextUrl.origin));
  if (!db.supabase) return new NextResponse("Attachments are not available in local development mode", { status: 501 });

  const { data, error } = await db.supabase.storage.from("attachments").createSignedUrl(path, 60);
  if (error || !data?.signedUrl) return new NextResponse("Attachment not found or not permitted", { status: 404 });
  return NextResponse.redirect(data.signedUrl);
}
