import { authorizationServerMetadata, originOf } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return Response.json(authorizationServerMetadata(originOf(req)), { headers: { "access-control-allow-origin": "*" } });
}
