import { noStore } from "@/lib/oauth";
import { getServiceDb, serviceConfigured } from "@/lib/service-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const error = (code: string, status = 400) => Response.json({ error: code }, { status, headers: noStore });

export async function POST(req: Request) {
  if (!serviceConfigured()) return error("temporarily_unavailable", 503);
  const type = req.headers.get("content-type") ?? "";
  const form = type.includes("application/json")
    ? new URLSearchParams(Object.entries(await req.json().catch(() => ({}))).map(([k, v]) => [k, String(v)]))
    : new URLSearchParams(await req.text());
  const get = (k: string) => form.get(k) ?? "";
  const db = await getServiceDb();

  let result: Record<string, unknown> | null = null;
  switch (get("grant_type")) {
    case "authorization_code":
      if (!get("code") || !get("client_id") || !get("redirect_uri") || !get("code_verifier")) return error("invalid_request");
      result = await db.call("oauth_exchange_code", {
        p_client_id: get("client_id"), p_code: get("code"), p_redirect_uri: get("redirect_uri"), p_code_verifier: get("code_verifier"),
      });
      break;
    case "refresh_token":
      if (!get("refresh_token") || !get("client_id")) return error("invalid_request");
      result = await db.call("oauth_refresh", { p_client_id: get("client_id"), p_refresh_token: get("refresh_token") });
      break;
    default:
      return error("unsupported_grant_type");
  }
  if (!result || typeof result.error === "string") return error(String(result?.error ?? "invalid_grant"));
  return Response.json(result, { headers: noStore });
}
