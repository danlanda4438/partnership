import { after } from "next/server";
import { dispatchPending } from "@/lib/dispatch";
import { handleMcpRequest } from "@/lib/mcp/server";
import { getServiceDb, serviceConfigured } from "@/lib/service-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: Request): Promise<Response> {
  if (!serviceConfigured()) {
    return Response.json({ error: { code: "internal", message: "MCP server is not configured yet" } }, { status: 503 });
  }
  const db = await getServiceDb();
  const origin = new URL(req.url).origin;
  const res = await handleMcpRequest(db, req, `${origin}/.well-known/oauth-protected-resource/api/mcp`);
  // Reports can requeue tasks or change approvals; notify affected bots after responding.
  after(() => dispatchPending(db).catch(() => {}));
  return res;
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
