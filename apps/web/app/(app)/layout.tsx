import Link from "next/link";
import { Nav } from "@/components/nav";
import { requireWorkspace } from "@/lib/context";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { db, email, workspace } = await requireWorkspace();
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
