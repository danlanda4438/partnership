import { Flash, PageHeader, Pill } from "@/components/ui";
import { act, str } from "@/lib/act";
import { canAdmin, requireWorkspace } from "@/lib/context";
import type { MemberItem, NotificationPrefs } from "@/lib/types";

export const dynamic = "force-dynamic";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function savePrefs(form: FormData) {
  "use server";
  await act("/settings", "Notification preferences saved", ({ db, workspace }) =>
    db.call("save_notification_preferences", {
      p_workspace_id: workspace!.id,
      p_digest_cadence: str(form, "digest_cadence"),
      p_digest_local_time: str(form, "digest_local_time") || "08:30",
      p_digest_weekday: Number(str(form, "digest_weekday") || 0),
      p_notify_approvals: form.get("notify_approvals") === "on",
      p_notify_exceptions: form.get("notify_exceptions") === "on",
      p_notify_material_changes: form.get("notify_material_changes") === "on",
    }),
  );
}

async function changeMember(form: FormData) {
  "use server";
  await act("/settings", "Member updated", ({ db }) =>
    db.call("set_member_role", {
      p_member_id: str(form, "member_id"),
      p_role: str(form, "role"),
      p_status: str(form, "status"),
    }),
  );
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { db, workspace } = await requireWorkspace();
  const [prefs, members] = await Promise.all([
    db.call<NotificationPrefs>("ui_notification_preferences", { p_workspace_id: workspace.id }),
    db.call<MemberItem[]>("ui_members", { p_workspace_id: workspace.id }),
  ]);
  const admin = canAdmin(workspace.role);

  return (
    <>
      <PageHeader title="Settings" subtitle={workspace.name} />
      <Flash ok={sp.ok} error={sp.error} />

      <section className="card narrow">
        <h3>Your digest & notifications</h3>
        <p className="notice small">
          Saved preferences only. Digest and notification delivery starts with the background worker (Phase 4). Nothing is scheduled until then, and nothing is ever scheduled without your settings here.
        </p>
        <form action={savePrefs} className="stack">
          <div className="row">
            <label>Digest
              <select name="digest_cadence" defaultValue={prefs.digest_cadence}>
                <option value="off">Off</option>
                <option value="daily">Every day</option>
                <option value="weekdays">Sunday–Thursday</option>
                <option value="weekly">Once a week</option>
              </select>
            </label>
            <label>Time (Jerusalem)<input type="time" name="digest_local_time" defaultValue={prefs.digest_local_time.slice(0, 5)} /></label>
            <label>Weekly on
              <select name="digest_weekday" defaultValue={String(prefs.digest_weekday)}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
          </div>
          <label className="check"><input type="checkbox" name="notify_approvals" defaultChecked={prefs.notify_approvals} /> Tell me when something needs my approval</label>
          <label className="check"><input type="checkbox" name="notify_exceptions" defaultChecked={prefs.notify_exceptions} /> Tell me about exceptions (blocked work, failed sends, unhealthy campaigns)</label>
          <label className="check"><input type="checkbox" name="notify_material_changes" defaultChecked={prefs.notify_material_changes} /> Include material changes (stage moves, replies) in the digest</label>
          <p className="muted small">Each item is sent to you once, not repeated.</p>
          <button type="submit">Save preferences</button>
        </form>
      </section>

      <section className="card narrow">
        <h3>Members</h3>
        <p className="muted small">New people are added by an owner with the setup tool (see the runbook). Access changes apply on their next click.</p>
        <ul className="plain">
          {members.map((m) => (
            <li key={m.member_id} className="member-row">
              <span>{m.email}{m.is_you ? <span className="muted small"> (you)</span> : null}</span>
              {admin && !m.is_you ? (
                <form action={changeMember} className="inline-form">
                  <input type="hidden" name="member_id" value={m.member_id} />
                  <select name="role" defaultValue={m.role} aria-label="Role">
                    <option value="owner">Owner</option>
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <select name="status" defaultValue={m.status} aria-label="Status">
                    <option value="active">Active</option>
                    <option value="revoked">Revoked</option>
                  </select>
                  <button type="submit" className="secondary">Save</button>
                </form>
              ) : (
                <span><Pill value={m.status === "active" ? "configured" : "revoked"} label={m.role} /></span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
