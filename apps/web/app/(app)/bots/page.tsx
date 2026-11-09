import { CHANNEL_KINDS, CHANNEL_LABELS } from "@gleeday/domain";
import { Empty, Flash, PageHeader, Pill, When } from "@/components/ui";
import { act, str } from "@/lib/act";
import { canAdmin, requireWorkspace } from "@/lib/context";
import type { BotItem } from "@/lib/types";

export const dynamic = "force-dynamic";

async function saveBot(form: FormData) {
  "use server";
  const budget = str(form, "daily_action_budget");
  await act("/bots", "Bot settings saved", async ({ db }) => {
    await db.call("set_worker_settings", {
      p_worker_id: str(form, "worker_id"),
      p_status: str(form, "status"),
      p_max_concurrent_tasks: Number(str(form, "max_concurrent_tasks") || 1),
      p_daily_action_budget: budget === "" ? null : Number(budget),
    });
    await db.call("set_worker_channels", {
      p_worker_id: str(form, "worker_id"),
      p_channels: form.getAll("channels").map(String),
    });
  });
}

export default async function BotsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { db, workspace } = await requireWorkspace();
  const bots = await db.call<BotItem[]>("ui_bots", { p_workspace_id: workspace.id });
  const admin = canAdmin(workspace.role);

  return (
    <>
      <PageHeader
        title="Bots"
        subtitle="Your existing bots, each with a role, the channels it may work in, and limits. Soled coordinates; the others do the work."
      />
      <Flash ok={sp.ok} error={sp.error} />
      {bots.length === 0 ? (
        <Empty>
          No bots connected yet. Each existing bot is mapped to a role and given its own access during onboarding (Phase 4). Bots never join automatically.
        </Empty>
      ) : (
        <div className="grid bots">
          {bots.map((b) => (
            <div className="card" key={b.id}>
              <div className="section-head">
                <h3>{b.name}</h3>
                <Pill value={b.status} />
              </div>
              <p className="muted small">{b.role}{b.description ? ` — ${b.description}` : ""}</p>
              <div className="small">
                {b.active_attempts} working now · last 7 days: {b.succeeded_7d} done, {b.blocked_7d} blocked, {b.failed_7d} failed/expired
              </div>
              <div className="small muted">Last seen: {b.last_seen_at ? <When at={b.last_seen_at} relative /> : "never"}</div>
              {b.capabilities.length ? <div className="small">Can: {b.capabilities.join(", ")}</div> : null}
              {admin ? (
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
                  <button type="submit" className="secondary">Save</button>
                </form>
              ) : (
                <div className="small">Channels: {b.channels.map((c) => CHANNEL_LABELS[c as keyof typeof CHANNEL_LABELS]).join(", ") || "none"}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
