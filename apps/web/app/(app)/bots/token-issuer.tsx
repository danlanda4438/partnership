"use client";
import { useActionState } from "react";
import { issueToken, type IssueState } from "./actions";

/** Issues a bot token and shows it exactly once. It never goes into a URL or the page history. */
export function TokenIssuer({ workerId }: { workerId: string }) {
  const [state, action, pending] = useActionState<IssueState, FormData>(issueToken, {});
  return (
    <div className="stack">
      <form action={action} className="inline-form">
        <input type="hidden" name="worker_id" value={workerId} />
        <input name="label" placeholder="Label, e.g. Claude Code routine" maxLength={80} />
        <select name="expires_in_days" defaultValue="90" aria-label="Expires">
          <option value="30">30 days</option>
          <option value="90">90 days</option>
          <option value="365">1 year</option>
        </select>
        <button type="submit" className="secondary" disabled={pending}>{pending ? "Creating…" : "Create token"}</button>
      </form>
      {state.error ? <p className="flash bad">{state.error}</p> : null}
      {state.token ? (
        <div className="flash ok">
          <strong>Copy this token now. It won't be shown again.</strong>
          <pre className="body token">{state.token}</pre>
          <span className="small">Store it only in the bot's secret settings. Never paste it into chats, tasks or documents.</span>
        </div>
      ) : null}
    </div>
  );
}
