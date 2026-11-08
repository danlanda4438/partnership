import { CHANNEL_KINDS, CHANNEL_LABELS, STAGES, STAGE_LABELS, type ChannelKind } from "@gleeday/domain";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SetupNotice } from "./setup-notice";

export const dynamic = "force-dynamic";

// Integrations the brief requires. Shown as "Not configured" until a real connection row exists.
const EXPECTED_INTEGRATIONS = [
  { provider: "google_sheets", label: "Google Sheets (migration source)" },
  { provider: "instantly", label: "Instantly" },
  { provider: "gmail", label: "Gmail (via bots' existing access)" },
  { provider: "routine_webhook", label: "Bot routines (webhooks)" },
  { provider: "command_center", label: "Command Center adapter" },
];

type StageCount = { channel_kind: ChannelKind; stage: string | null; opportunity_count: number; organization_count: number };

export default async function OverviewPage() {
  const supabase = await createClient();
  if (!supabase) return <SetupNotice />;

  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims) redirect("/login");

  const [workspaces, counts, approvals, blocked, connections] = await Promise.all([
    supabase.from("workspaces").select("id, name").order("name"),
    supabase.from("channel_stage_counts").select("channel_kind, stage, opportunity_count, organization_count"),
    supabase.from("approvals").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("tasks").select("id", { count: "exact", head: true }).in("status", ["blocked", "dead_lettered"]),
    supabase.from("integration_connections").select("provider, display_name, status, blocked_reason"),
  ]);

  const workspace = workspaces.data?.[0];
  if (!workspace) {
    return (
      <Shell email={String(claims.claims.email ?? "")}>
        <p className="notice">
          You are signed in, but you are not a member of any workspace yet. Ask an owner to add you
          (see <code>docs/RUNBOOK.md</code> → “Bootstrap the first workspace”).
        </p>
      </Shell>
    );
  }

  const rows = (counts.data ?? []) as StageCount[];
  const cell = (kind: ChannelKind, stage: string | null) => rows.find((r) => r.channel_kind === kind && r.stage === stage);

  return (
    <Shell email={String(claims.claims.email ?? "")}>
      <h1>{workspace.name}</h1>
      <p className="muted">
        Phase 1 foundation. Pipelines, approvals, bots and integrations are added in later phases.
        Numbers below come live from the database.
      </p>

      <h2>Needs you</h2>
      <div className="grid">
        <div className="card"><h3>Pending approvals</h3><div className="stat">{approvals.count ?? 0}</div></div>
        <div className="card"><h3>Blocked or failed tasks</h3><div className="stat">{blocked.count ?? 0}</div></div>
      </div>

      <h2>Pipelines</h2>
      <p className="muted">Each cell: opportunities · organizations. “Not contacted” is inventory, outside the funnel.</p>
      <div className="grid">
        {CHANNEL_KINDS.map((kind) => (
          <div className="card" key={kind}>
            <h3>{CHANNEL_LABELS[kind]}</h3>
            <table>
              <tbody>
                {[null, ...STAGES].map((stage) => {
                  const c = cell(kind, stage);
                  return (
                    <tr key={stage ?? "none"}>
                      <td>{stage ? STAGE_LABELS[stage] : "Not contacted"}</td>
                      <td className="num">{c ? `${c.opportunity_count} · ${c.organization_count}` : "0 · 0"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <h2>Integrations</h2>
      <div className="card">
        <table>
          <thead><tr><th>Connection</th><th>Status</th></tr></thead>
          <tbody>
            {EXPECTED_INTEGRATIONS.map((i) => {
              const conn = connections.data?.find((c) => c.provider === i.provider);
              const status = conn?.status ?? "not_configured";
              return (
                <tr key={i.provider}>
                  <td>{conn?.display_name ?? i.label}</td>
                  <td>
                    <span className={`pill ${status === "healthy" ? "ok" : "warn"}`}>{status.replace("_", " ")}</span>
                    {conn?.blocked_reason ? <span className="muted"> — {conn.blocked_reason}</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Shell>
  );
}

function Shell({ email, children }: { email: string; children: React.ReactNode }) {
  return (
    <>
      <header className="top">
        <strong>Gleeday Operations Center</strong>
        <form action="/auth/signout" method="post">
          <span className="muted">{email} · </span>
          <button className="link" type="submit">Sign out</button>
        </form>
      </header>
      <main>{children}</main>
    </>
  );
}
