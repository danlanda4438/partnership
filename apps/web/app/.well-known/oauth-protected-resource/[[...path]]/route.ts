import { originOf, protectedResourceMetadata } from "@/lib/oauth";

export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return Response.json(protectedResourceMetadata(originOf(req)), { headers: { "access-control-allow-origin": "*" } });
}
