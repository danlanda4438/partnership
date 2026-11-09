import { getContext } from "@/lib/context";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function NoWorkspacePage() {
  const { email, workspace } = await getContext();
  if (workspace) redirect("/");
  return (
    <main>
      <h1>No workspace yet</h1>
      <p className="notice">
        You are signed in as <strong>{email}</strong>, but you are not a member of any workspace. Ask an owner to add
        you (see <code>docs/RUNBOOK.md</code> → “Bootstrap the first workspace”).
      </p>
      <form action="/auth/signout" method="post">
        <button className="link" type="submit">Sign out</button>
      </form>
    </main>
  );
}
