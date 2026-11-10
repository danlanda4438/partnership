import Link from "next/link";
import { after } from "next/server";
import { dispatchPending } from "@/lib/dispatch";
import { getServiceDb, serviceConfigured } from "@/lib/service-db";
import { Nav } from "@/components/nav";
import { requireWorkspace } from "@/lib/context";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { db, email, workspace } = await requireWorkspace();
  // Any page view also sends waiting bot notifications (and retries failed ones), so bots
  // don't wait for the once-a-day background run.
  after(async () => {
    if (serviceConfigured()) await dispatchPending(await getServiceDb(), { limit: 10 }).catch(() => {});
  });
  const [approvals, exceptions] = await Promise.all([
    db.call<unknown[]>("ui_approvals", { p_workspace_id: workspace.id, p_status: "pending" }),
    db.call<unknown[]>("ui_exceptions", { p_workspace_id: workspace.id }),
  ]);

  return (
    <div className="shell">
      <header className="top">
        <Link href="/" className="brand">
          Gleeday <span className="muted">Operations</span>
        </Link>
        <div className="top-right">
          <span className="muted who">
            {email} · {workspace.role}
          </span>
          <form action="/auth/signout" method="post">
            <button className="link" type="submit">Sign out</button>
          </form>
        </div>
      </header>
      <div className="body">
        <Nav counts={{ approvals: approvals?.length ?? 0, exceptions: exceptions?.length ?? 0 }} />
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
