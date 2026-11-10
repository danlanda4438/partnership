import { after } from "next/server";
import { dispatchPending } from "@/lib/dispatch";
import { handleMcpRequest } from "@/lib/mcp/server";
import { getServiceDb, serviceConfigured } from "@/lib/service-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// A bot's personal MCP address: /api/mcp/<bot-slug>. Only that bot's sign-in is accepted here.
async function handle(req: Request, { params }: { params: Promise<{ bot: string }> }): Promise<Response> {
  const { bot } = await params;
  if (!/^[a-z0-9-]{1,64}$/.test(bot)) return Response.json({ error: { code: "not_found", message: "Unknown bot address" } }, { status: 404 });
  if (!serviceConfigured()) {
    return Response.json({ error: { code: "internal", message: "MCP server is not configured yet" } }, { status: 503 });
  }
  const db = await getServiceDb();
  const origin = new URL(req.url).origin;
  const res = await handleMcpRequest(db, req, `${origin}/.well-known/oauth-protected-resource/api/mcp/${bot}`, bot);
  after(() => dispatchPending(db).catch(() => {}));
  return res;
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
