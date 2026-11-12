// Delivers queued webhook notifications to bot routines (Claude scheduled tasks with an API trigger).
//
// Protocol (Claude Code docs, "Trigger a scheduled task"): POST <fire URL> with
//   Authorization: Bearer <routine token>, anthropic-beta: experimental-cc-routine-2026-04-01,
//   anthropic-version: 2023-06-01, body {"text": "..."}.
// The routine receives `text` wrapped as untrusted data, so it only says WHICH work exists;
// the routine's saved prompt says what to do (call the MCP tools). A successful fire only
// means a session started: the task is complete only when the bot reports through MCP.
//
// Grok Bot routines (xAI docs, "Skills and routines" → webhook triggers): POST to the routine's
// webhook URL with Authorization: Bearer <key> and an optional JSON body. A 200 only means a run
// started. Any URL that is not on api.anthropic.com is treated as this generic JSON webhook.
//
// Each bot's fire URL and token live in server-side environment variables named by its
// routine_secret_ref: <REF>_URL and <REF>_TOKEN. They are never stored in the database.
import type { ServiceDb } from "./service-db";

export const ROUTINE_BETA = "experimental-cc-routine-2026-04-01";

interface DueDelivery {
  id: string;
  worker_id: string;
  routine_secret_ref: string | null;
  event_type: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export function fireText(d: Pick<DueDelivery, "event_type" | "payload">): string {
  const lines = [`Gleeday Partnership Ops notification: ${d.event_type}`];
  for (const key of ["task_id", "kind", "approval_id", "decision"]) {
    const v = d.payload[key];
    if (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(v)) lines.push(`${key}: ${v}`);
  }
  lines.push("This only identifies work. Look it up and process it with the Gleeday Partnership Ops MCP tools.");
  return lines.join("\n");
}

/** JSON body for Grok Bot / generic webhooks: ids only, never instructions. */
export function webhookBody(d: Pick<DueDelivery, "event_type" | "payload">): Record<string, string> {
  const body: Record<string, string> = { source: "gleeday-operations", event: d.event_type };
  for (const key of ["task_id", "kind", "approval_id", "decision"]) {
    const v = d.payload[key];
    if (typeof v === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(v)) body[key] = v;
  }
  body.note = "Notification only. Look up and process this work with the Gleeday Partnership Ops MCP tools.";
  return body;
}

export function isAnthropicRoutine(url: string): boolean {
  try {
    return new URL(url).hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

export interface DispatchResult {
  attempted: number;
  sent: number;
  failed: number;
}

export async function dispatchPending(
  db: ServiceDb,
  opts: { limit?: number; env?: Record<string, string | undefined>; fetchImpl?: typeof fetch } = {},
): Promise<DispatchResult> {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? fetch;
  const due = await db.rows<DueDelivery>("dispatch_claim", { p_limit: opts.limit ?? 20 });
  const result: DispatchResult = { attempted: due.length, sent: 0, failed: 0 };

  for (const d of due) {
    const ref = d.routine_secret_ref;
    const url = ref ? env[`${ref}_URL`] : undefined;
    const token = ref ? env[`${ref}_TOKEN`] : undefined;
    let ok = false;
    let status: number | null = null;
    let error: string | null = null;
    let response: unknown = null;

    if (!url || !token) {
      error = `Routine not configured: set ${ref ?? "<REF>"}_URL and ${ref ?? "<REF>"}_TOKEN on the server`;
    } else if (!/^https:\/\//.test(url)) {
      error = "Routine URL must use https";
    } else {
      try {
        const claude = isAnthropicRoutine(url);
        const res = await doFetch(url, {
          method: "POST",
          headers: claude
            ? {
                authorization: `Bearer ${token}`,
                "anthropic-beta": ROUTINE_BETA,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
              }
            : { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(claude ? { text: fireText(d) } : webhookBody(d)),
          signal: AbortSignal.timeout(15_000),
        });
        status = res.status;
        const text = await res.text();
        try { response = JSON.parse(text); } catch { response = { body: text.slice(0, 500) }; }
        ok = res.ok;
        if (!ok) error = `Routine responded ${res.status}`;
      } catch (err) {
        error = err instanceof Error ? err.message : "request failed";
      }
    }

    await db.call("dispatch_complete", {
      p_id: d.id, p_ok: ok, p_status_code: status, p_error: error,
      p_response: response && typeof response === "object" ? response : null,
    });
    if (ok) result.sent++;
    else result.failed++;
  }
  return result;
}
