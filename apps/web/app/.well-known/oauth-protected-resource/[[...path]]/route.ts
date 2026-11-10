import { originOf, protectedResourceMetadata } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  const { path } = await params;
  return Response.json(protectedResourceMetadata(originOf(req), (path ?? []).join("/") || "api/mcp"), {
    headers: { "access-control-allow-origin": "*" },
  });
}
