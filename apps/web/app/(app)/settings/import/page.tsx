import { PageHeader, When } from "@/components/ui";
import { canAdmin, requireWorkspace } from "@/lib/context";
import type { Integrations } from "@/lib/types";
import { ImportClient } from "./import-client";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const { db, workspace } = await requireWorkspace();
  if (!canAdmin(workspace.role)) {
    return <><PageHeader title="Import data" /><p className="notice">Only owners and admins can import data.</p></>;
  }
  const integrations = await db.call<Integrations>("ui_integrations", { p_workspace_id: workspace.id });
  const runs = integrations.import_batches.filter((b) => b.kind === "upsert");
  return (
    <>
      <PageHeader title="Import data" subtitle="Bring your partnership spreadsheets into the app, with a full archive and a link from every record to the row it came from." />
      <ImportClient />
      {runs.length ? (
        <section>
          <h2>Previous imports</h2>
          <ul className="list compact">
            {runs.map((b) => (
              <li key={b.id}>
                <div className="list-main"><strong>{b.status}</strong><span className="muted small">started <When at={b.started_at} />{b.finished_at ? <> · finished <When at={b.finished_at} /></> : null}</span></div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
