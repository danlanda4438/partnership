import { headers } from "next/headers";
import { CHANNEL_KINDS, CHANNEL_LABELS } from "@gleeday/domain";
import { Empty, Flash, PageHeader, Pill, When } from "@/components/ui";
import { canAdmin, requireWorkspace } from "@/lib/context";
import { botSlug } from "@/lib/mcp/server";
import type { BotItem } from "@/lib/types";
import { createBot, revokeConnection, revokeToken, saveBot } from "./actions";
import { TokenIssuer } from "./token-issuer";

export const dynamic = "force-dynamic";

interface TokenItem { id: string; worker_id: string; label: string | null; created_at: string; expires_at: string | null; revoked_at: string | null; last_used_at: string | null; active: boolean }
interface GrantItem { id: string; client_name: string; worker_id: string; worker: string; created_at: string; revoked_at: string | null; last_used_at: string | null }
interface DeliveryItem { id: string; worker: string; event_type: string; status: string; attempts: number; last_error: string | null; created_at: string; sent_at: string | null; session_url: string | null }

export default async function BotsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { db, workspace } = await requireWorkspace();
  const admin = canAdmin(workspace.role);
  const h = await headers();
  const origin = `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`;
  const [bots, tokens, grants, deliveries] = await Promise.all([
    db.call<BotItem[]>("ui_bots", { p_workspace_id: workspace.id }),
    admin ? db.call<TokenItem[]>("ui_worker_tokens", { p_workspace_id: workspace.id }) : Promise.resolve([] as TokenItem[]),
    admin ? db.call<GrantItem[]>("ui_connector_grants", { p_workspace_id: workspace.id }) : Promise.resolve([] as GrantItem[]),
    db.call<DeliveryItem[]>("ui_deliveries", { p_workspace_id: workspace.id }),
  ]);

  return (
    <>
      <PageHeader
        title="Bots"
        subtitle="Each existing bot gets its own identity, channels, limits and access. Soled coordinates; the others do the work. Bots never join automatically."
      />
      <Flash ok={sp.ok} error={sp.error} />

      <section className="card">
        <h3>How bots connect</h3>
        <p className="small">
          Each bot connects to its <strong>own address</strong>, shown on its card (<code>{origin}/api/mcp/&lt;bot&gt;</code>). That address only accepts that bot, so bots can't act as each other even if their app shares connectors. Two ways to connect:
        </p>
        <ul className="small">
          <li><strong>claude.ai connector</strong> (for Claude routines): add a custom connector with that address. When asked, sign in here and choose which bot it acts as.</li>
          <li><strong>Token</strong> (for Claude Code, scripts and other agents): create a token below and send it as <code>Authorization: Bearer …</code>.</li>
        </ul>
        <p className="muted small">Full steps: docs/BOT_CONNECTION_GUIDE.md in the repository.</p>
      </section>

      {bots.length === 0 ? <Empty>No bots yet. Add each of your existing bots below, starting with Soled (role “coordinator”).</Empty> : null}

      <div className="grid bots">
        {bots.map((b) => (
          <div className="card" key={b.id}>
            <div className="section-head">
              <h3>{b.name}</h3>
              <Pill value={b.status} />
            </div>
            <p className="muted small">{b.role}{b.description ? ` — ${b.description}` : ""}</p>
            <div className="small">Connector address: <code className="copyable">{origin}/api/mcp/{botSlug(b.name)}</code></div>
            <div className="small">
              {b.active_attempts} working now · last 7 days: {b.succeeded_7d} done, {b.blocked_7d} blocked, {b.failed_7d} failed/expired
            </div>
            <div className="small muted">Last task activity: {b.last_seen_at ? <When at={b.last_seen_at} relative /> : "never"}</div>
            {admin ? (
              <>
                <form action={saveBot} className="stack top-gap">
                  <input type="hidden" name="worker_id" value={b.id} />
                  <fieldset className="checks">
                    <legend className="small">Channels</legend>
                    {CHANNEL_KINDS.map((k) => (
                      <label key={k} className="check"><input type="checkbox" name="channels" value={k} defaultChecked={b.channels.includes(k)} /> {CHANNEL_LABELS[k]}</label>
                    ))}
                  </fieldset>
                  <div className="row">
                    <label>Status
                      <select name="status" defaultValue={b.status}>
                        <option value="active">Active</option>
                        <option value="paused">Paused</option>
                        <option value="revoked">Revoked</option>
                      </select>
                    </label>
                    <label>Parallel tasks<input type="number" name="max_concurrent_tasks" min={1} max={50} defaultValue={b.max_concurrent_tasks} /></label>
                    <label>Daily action limit<input type="number" name="daily_action_budget" min={0} defaultValue={b.daily_action_budget ?? ""} placeholder="No limit" /></label>
                  </div>
                  <label>Routine name (for notifications)
                    <input name="routine_secret_ref" defaultValue={b.routine_secret_ref ?? ""} placeholder="e.g. AFFILIATE_BOT" pattern="[A-Za-z][A-Za-z0-9_]{2,63}" />
                  </label>
                  <p className="muted small">
                    The routine's fire URL and token go in the server settings as <code>{(b.routine_secret_ref ?? "NAME") + "_URL"}</code> and <code>{(b.routine_secret_ref ?? "NAME") + "_TOKEN"}</code>, never here.
                  </p>
                  <button type="submit" className="secondary">Save</button>
                </form>

                <div className="top-gap">
                  <div className="small"><strong>Tokens</strong></div>
                  <ul className="plain small">
                    {tokens.filter((t) => t.worker_id === b.id && !t.label?.startsWith("Connector:")).map((t) => (
                      <li key={t.id} className="member-row">
                        <span>
                          {t.label ?? "Token"} · created <When at={t.created_at} />
                          {t.last_used_at ? <> · used <When at={t.last_used_at} relative /></> : " · never used"}
                        </span>
                        {t.active ? (
                          <form action={revokeToken}><input type="hidden" name="credential_id" value={t.id} /><button className="link danger-text small" type="submit">Revoke</button></form>
                        ) : <span className="muted">{t.revoked_at ? "revoked" : "expired"}</span>}
                      </li>
                    ))}
                  </ul>
                  <TokenIssuer workerId={b.id} />
                </div>
              </>
            ) : (
              <div className="small">Channels: {b.channels.map((c) => CHANNEL_LABELS[c as keyof typeof CHANNEL_LABELS]).join(", ") || "none"}</div>
            )}
          </div>
        ))}
      </div>

      {admin ? (
        <section className="card narrow">
          <h3>Add a bot</h3>
          <form action={createBot} className="stack">
            <div className="row">
              <label>Name<input name="name" required placeholder="e.g. Soled" maxLength={60} /></label>
              <label>Role<input name="role" required placeholder="coordinator, affiliates, media_pr…" maxLength={40} /></label>
            </div>
            <label>What it does<input name="description" maxLength={200} /></label>
            <fieldset className="checks">
              <legend className="small">Channels</legend>
              {CHANNEL_KINDS.map((k) => <label key={k} className="check"><input type="checkbox" name="channels" value={k} /> {CHANNEL_LABELS[k]}</label>)}
            </fieldset>
            <label className="check"><input type="checkbox" name="capabilities" value="gmail.send" /> May send approved emails (through its own Gmail access)</label>
            <p className="muted small">The role “coordinator” (Soled) is notified about unassigned tasks.</p>
            <button type="submit">Add bot</button>
          </form>
        </section>
      ) : null}

      {admin && grants.length ? (
        <section>
          <h2>Connector connections</h2>
          <ul className="list compact">
            {grants.map((g) => (
              <li key={g.id}>
                <div className="list-main"><strong>{g.client_name} → {g.worker}</strong><span className="muted small">connected <When at={g.created_at} />{g.last_used_at ? <> · used <When at={g.last_used_at} relative /></> : null}</span></div>
                <span className="list-side">
                  {g.revoked_at ? <span className="muted small">disconnected</span> : (
                    <form action={revokeConnection}><input type="hidden" name="grant_id" value={g.id} /><button className="link danger-text small" type="submit">Disconnect</button></form>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h2>Recent notifications to bots</h2>
        <p className="muted small">A sent notification only starts the bot's routine. Work counts as done only when the bot reports back.</p>
        {deliveries.length === 0 ? <Empty>No notifications yet.</Empty> : (
          <ul className="list compact">
            {deliveries.slice(0, 20).map((d) => (
              <li key={d.id}>
                <div className="list-main">
                  <span><strong>{d.worker}</strong> · {d.event_type}</span>
                  <span className="muted small">
                    {d.status === "skipped" ? (d.last_error ?? "No routine linked to this bot") : d.last_error ?? (d.session_url ? <a href={d.session_url} target="_blank" rel="noreferrer">Open the bot's session</a> : null)}
                  </span>
                </div>
                <span className="list-side">
                  <Pill value={d.status === "sent" ? "healthy" : d.status === "skipped" ? "unknown" : d.status === "dead" || d.status === "failed" ? "error" : "configured"} label={d.status} />
                  <span className="muted small"><When at={d.created_at} relative /></span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
