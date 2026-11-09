import { noStore } from "@/lib/oauth";
import { getServiceDb, serviceConfigured, ServiceDbError } from "@/lib/service-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Dynamic client registration (RFC 7591). Registering a client grants nothing by itself:
// an owner/admin must still sign in and approve it for a specific bot.
export async function POST(req: Request) {
  if (!serviceConfigured()) return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
  let body: { client_name?: unknown; redirect_uris?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_client_metadata", error_description: "JSON body required" }, { status: 400 });
  }
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  try {
    const db = await getServiceDb();
    const client = await db.call("oauth_register_client", {
      p_client_name: typeof body.client_name === "string" ? body.client_name : "MCP client",
      p_redirect_uris: uris,
    });
    return Response.json(client, { status: 201, headers: noStore });
  } catch (err) {
    const message = err instanceof ServiceDbError && err.code === "22023" ? err.message : "registration failed";
    return Response.json({ error: "invalid_redirect_uri", error_description: message }, { status: 400 });
  }
}
