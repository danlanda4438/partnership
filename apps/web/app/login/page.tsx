import { publicSupabaseEnv } from "@/lib/env";
import { SetupNotice } from "../setup-notice";
import { sendLoginLink } from "./actions";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string; next?: string }> }) {
  if (!publicSupabaseEnv()) return <SetupNotice />;
  const { sent, error, next } = await searchParams;
  return (
    <main>
      <h1>Sign in</h1>
      <p className="muted">Gleeday Partnership Ops is invite-only.</p>
      {sent ? (
        <p className="notice">If this address has access, a sign-in link is on its way. Check your inbox.</p>
      ) : (
        <form action={sendLoginLink} className="stack">
          <input type="email" name="email" required placeholder="you@gleeday.com" autoComplete="email" />
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <button type="submit">Email me a sign-in link</button>
        </form>
      )}
      {error ? <p className="notice">That sign-in link was invalid or expired. Request a new one.</p> : null}
    </main>
  );
}
