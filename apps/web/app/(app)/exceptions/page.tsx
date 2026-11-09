import Link from "next/link";
import { Empty, PageHeader, When } from "@/components/ui";
import { requireWorkspace } from "@/lib/context";
import type { ExceptionItem } from "@/lib/types";

export const dynamic = "force-dynamic";

const GROUPS: { title: string; prefix: string; help: string }[] = [
  { title: "Uncertain or failed sends", prefix: "approval_", help: "The outcome must be checked with the provider before anything is retried." },
  { title: "Blocked or failed tasks", prefix: "task_", help: "A bot stopped and needs a decision or information." },
  { title: "Records needing verification", prefix: "opportunity_", help: "Marked blocked or needs-verification." },
  { title: "Ambiguous identities", prefix: "identity_", help: "The same unverified email or profile is attached to more than one person. Nothing is merged automatically." },
  { title: "Unhealthy campaigns", prefix: "campaign_", help: "Paused or in error. This is campaign health, separate from partner progress." },
  { title: "Connection problems", prefix: "connection_", help: "Integrations that are degraded, blocked or revoked." },
];

export default async function ExceptionsPage() {
  const { db, workspace } = await requireWorkspace();
  const items = await db.call<ExceptionItem[]>("ui_exceptions", { p_workspace_id: workspace.id });

  return (
    <>
      <PageHeader title="Exceptions" subtitle="Everything that stopped or looks wrong. Work here is never retried automatically." />
      {items.length === 0 ? <Empty>No exceptions. Everything is running normally.</Empty> : null}
      {GROUPS.map((g) => {
        const group = items.filter((i) => i.kind.startsWith(g.prefix));
        if (group.length === 0) return null;
        return (
          <section key={g.prefix}>
            <h2>{g.title} <span className="muted">({group.length})</span></h2>
            <p className="muted small">{g.help}</p>
            <ul className="list">
              {group.map((x) => (
                <li key={`${x.kind}-${x.id}`}>
                  <div className="list-main">
                    {x.link ? <Link href={x.link}><strong>{x.title}</strong></Link> : <strong>{x.title}</strong>}
                    <span className="muted">{x.detail}</span>
                  </div>
                  <span className="list-side small"><When at={x.since} relative /></span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
