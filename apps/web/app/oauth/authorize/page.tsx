import { redirect } from "next/navigation";
import { getDb, isConfigured } from "@/lib/data";
import { botSlug } from "@/lib/mcp/server";
import { decideAuthorization } from "./actions";

export const dynamic = "force-dynamic";

interface Params {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  resource?: string;
  scope?: string;
}

function Problem({ message }: { message: string }) {
  return (
    <main>
      <h1>Can't connect</h1>
      <p className="notice">{message}</p>
    </main>
  );
}

export default async function AuthorizePage({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  if (!isConfigured()) return <Problem message="The app is not configured yet." />;
  const db = await getDb();
  if (!db) {
    const back = `/oauth/authorize?${new URLSearchParams(p as Record<string, string>).toString()}`;
    redirect(`/login?next=${encodeURIComponent(back)}`);
  }

  if (p.response_type !== "code") return <Problem message="Unsupported request (response_type must be code)." />;
  if (!p.client_id || !p.redirect_uri) return <Problem message="The request is missing client_id or redirect_uri." />;
  if (p.code_challenge_method !== "S256" || !p.code_challenge) return <Problem message="The connector must use PKCE (S256)." />;

  const client = await db.call<{ client_id: string; client_name: string } | null>("oauth_client_info", {
    p_client_id: p.client_id, p_redirect_uri: p.redirect_uri,
  });
  if (!client) return <Problem message="Unknown connector or redirect address. Remove the connector and add it again." />;
  const allWorkers = await db.call<{ id: string; name: string; role: string; workspace: string }[]>("ui_connectable_workers");
  // A bot's personal address (…/api/mcp/<bot>) can only be connected as that bot.
  const forBot = /\/api\/mcp\/([a-z0-9-]{1,64})\/?$/.exec(p.resource ?? "")?.[1];
  const workers = forBot ? allWorkers.filter((w) => botSlug(w.name) === forBot) : allWorkers;
  if (forBot && workers.length === 0) return <Problem message={`No bot matches the address "${forBot}". Check the bot's address on the Bots page.`} />;
  const redirectHost = new URL(p.redirect_uri).host;

  return (
    <main>
      <h1>Connect a bot</h1>
      <p>
        <strong>{client.client_name}</strong> ({redirectHost}) wants to act in Gleeday Partnership Ops <strong>as one of your bots</strong>.
        It will get that bot's access only: its channels, tasks and limits. Every outgoing message, price, spend or commitment still needs your approval.
      </p>
      {workers.length === 0 ? (
        <p className="notice">There are no bots you can connect. Only owners and admins can connect bots; add the bot first under Bots.</p>
      ) : (
        <form action={decideAuthorization} className="stack card narrow">
          {Object.entries(p).map(([k, v]) => (typeof v === "string" ? <input key={k} type="hidden" name={k} value={v} /> : null))}
          <label>Act as
            <select name="worker_id" required defaultValue={workers.length === 1 ? workers[0].id : ""}>
              <option value="" disabled>Choose a bot…</option>
              {workers.map((w) => <option key={w.id} value={w.id}>{w.name} ({w.role}) — {w.workspace}</option>)}
            </select>
          </label>
          <div className="row">
            <button type="submit" name="decision" value="approve">Allow</button>
            <button type="submit" name="decision" value="deny" className="secondary">Deny</button>
          </div>
          <p className="muted small">You can disconnect it at any time under Bots → Connections.</p>
        </form>
      )}
    </main>
  );
}
