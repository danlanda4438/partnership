export function SetupNotice() {
  return (
    <main>
      <h1>Gleeday Operations Center</h1>
      <p className="notice">
        <strong>Not configured.</strong> Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> (see <code>.env.example</code> and{" "}
        <code>docs/RUNBOOK.md</code>).
      </p>
    </main>
  );
}
