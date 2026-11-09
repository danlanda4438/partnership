import { timingSafeEqual } from "node:crypto";
import { dispatchPending } from "@/lib/dispatch";
import { getServiceDb, serviceConfigured } from "@/lib/service-db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Scheduled housekeeping: expire stale leases and overdue approvals, then deliver pending
// bot notifications. Called by Vercel Cron (or any scheduler) with Authorization: Bearer <CRON_SECRET>.
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const got = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!secret || !got) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(req: Request): Promise<Response> {
  if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!serviceConfigured()) return Response.json({ error: "not configured" }, { status: 503 });
  const db = await getServiceDb();
  const maintenance = await db.call("run_maintenance");
  const dispatch = await dispatchPending(db, { limit: 50 });
  return Response.json({ maintenance, dispatch });
}

export const GET = handle;
export const POST = handle;
