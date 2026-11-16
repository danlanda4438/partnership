// Builds a bot's handover file: what the app knows about the bot, how to connect a new agent
// in its place, the rules the server enforces, and the bot's own knowledge (written weekly).
// Someone other than the owner can copy it into a new agent and connect it.
import { CHANNEL_LABELS, type ChannelKind } from "@gleeday/domain";
import { botSlug, SERVER_INSTRUCTIONS } from "./mcp/server";
import type { BotKnowledge } from "./types";

const CAPABILITY_LABELS: Record<string, string> = {
  "gmail.send": "May send emails the owner approved, through its own Gmail access",
  "tasks.assign": "Coordinator: plans work and creates and assigns tasks for the other bots",
  "impact.manage": "May carry out impact.com actions the owner approved",
};

const day = (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().slice(0, 10) : "never");

export const KNOWLEDGE_STALE_DAYS = 8;
export const isStale = (iso: string | null | undefined) =>
  !iso || Date.now() - new Date(iso).getTime() > KNOWLEDGE_STALE_DAYS * 24 * 3600 * 1000;

export function knowledgeFileName(name: string) {
  return `${botSlug(name)}-knowledge.md`;
}

export function buildHandover(k: BotKnowledge, origin: string): string {
  const b = k.bot;
  const address = `${origin}/api/mcp/${botSlug(b.name)}`;
  const programs = b.channels.map((c) => CHANNEL_LABELS[c as ChannelKind] ?? c).join(", ") || "none yet";
  const ref = b.routine_secret_ref ?? botSlug(b.name).toUpperCase().replace(/-/g, "_");
  const perms = b.capabilities.length ? b.capabilities.map((c) => `  - ${CAPABILITY_LABELS[c] ?? c}`).join("\n") : "  - Only its own tasks; everything outward-facing needs the owner's approval";

  return `# ${b.name}: knowledge file and handover

_Made by Gleeday Partnership Ops on ${day(new Date().toISOString())}. The bot's own part (section 4) was last updated ${
    k.current ? `${day(k.current.updated_at)} by ${k.current.written_by}` : "never"
  }._

Use this file to set up a new agent that does this bot's job, or to understand what it does. It has no passwords, tokens or keys; those are kept in the app and in the server settings.

## 1. This bot in the app

- **Name:** ${b.name}
- **Role:** ${b.role}${b.description ? `\n- **What it does:** ${b.description}` : ""}
- **Programs:** ${programs}
- **Permissions:**
${perms}
- **Limits:** ${b.max_concurrent_tasks} task(s) at a time · ${b.daily_action_budget == null ? "no daily action limit" : `${b.daily_action_budget} approved actions per day`}
- **Status:** ${b.status}

## 2. Connect a new agent in its place

You need to be an owner or admin in Gleeday Partnership Ops for steps 2 and 5.

1. In the new agent (Grok, Claude or another agent that supports MCP connectors), add a custom MCP connector:
   - Address: \`${address}\`
   - Name: \`Gleeday Ops – ${b.name}\`
2. When it asks you to sign in, sign in to Gleeday Partnership Ops, choose **${b.name}** under **Act as**, and click **Allow**.
   _Agent can't sign in? On the Bots page, create a token for ${b.name} and give the agent \`Authorization: Bearer <token>\`._
3. Give the agent its instructions: section 3 (the app's rules) and the standing instructions in section 4. Tell it to use ONLY the connector named \`Gleeday Ops – ${b.name}\`.
4. Check it: ask the agent \`Call whoAmI on Gleeday Ops\`. It must answer **${b.name}** with programs: ${programs}.
5. So the app can wake it: create a routine with a webhook trigger that uses the same instructions. Put the routine's URL and key in the server settings (Vercel → Settings → Environment Variables) as \`${ref}_URL\` and \`${ref}_TOKEN\`, set the bot's **Routine name** on the Bots page to \`${ref}\`, and redeploy.
6. Replacing an old agent? On the Bots page, disconnect the old one under **Connector connections** and revoke its old tokens.
7. Ask the new agent to read this bot's knowledge with \`getKnowledge\`, and keep it current with \`updateKnowledge\` (it gets a reminder task every week).

## 3. Rules the app enforces (paste into the agent's instructions)

\`\`\`
${SERVER_INSTRUCTIONS}
\`\`\`

## 4. What this bot knows (written by the bot, refreshed every week)

${k.current ? k.current.body.trim() : "_Not written yet. The bot gets a task to write it at the next daily run, or an owner can ask for it now from the Bots page._"}
`;
}
