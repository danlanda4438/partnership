# Bot connection guide (Grok Bot)

How to connect your five existing **Grok bots** (Soled, Gleeday affiliates, Gleeday Co-Marketing, Gleeday Media & PR, Gleeday Listing) to Gleeday Operations. Bots never join automatically. Each one gets its own identity, channels and limits, and you approve every connection.

## How it works

```
App: a task is assigned, or you decide on a proposal
   │ webhook: only an event name and ids, never instructions
   ▼
Grok Bot routine (webhook trigger)
   │ uses the "Gleeday Ops" connector, as itself
   ▼
Gleeday Operations MCP server: claim → context → propose → (you approve) → send once → report
```

- The **MCP server** at `https://<your-app>/api/mcp` is the only way bots read or change operational data.
- A **webhook** only starts a bot run. Work is done only when the bot reports back.
- Every outgoing email, price, spend or commitment waits in **Approvals**. Grok's own "allow" prompt for sending through Gmail still applies on top.
- **impact.com** is used by Soled, Gleeday affiliates and Gleeday Co-Marketing. They record what happens there (impact.* events) and ask approval for any partner-facing or terms-setting impact.com action. Only bots with the `impact.manage` permission can carry those out (see `supabase/manual/05_impact_permissions.sql`).

## Step 1: Register the bots (once)

Run `supabase/manual/04_create_bots.sql` in the Supabase SQL Editor. It creates the five bots:

| Bot | Role | Channels | Can |
|---|---|---|---|
| Soled | coordinator | all four | assign tasks, send approved emails |
| Gleeday affiliates | affiliates | Affiliates | send approved emails |
| Gleeday Co-Marketing | co_marketing | Co-Marketing | send approved emails |
| Gleeday Media & PR | media_pr | Media & PR | send approved emails |
| Gleeday Listing | listings | Listings | send approved emails |

Each starts with a daily limit (Soled 20, others 25 approved actions per 24 hours). You can change limits, channels or pause any bot on the **Bots** page.

## Step 2: Connect each bot (in Grok)

Grok connects to outside tools only by OAuth sign-in. The app supports exactly that.

Each bot has its **own address**. That address only accepts that bot, so even if Grok shares connectors between bots, one bot can't act as another:

| Bot | Its address |
|---|---|
| Soled | `https://<your-app>/api/mcp/soled` |
| Gleeday affiliates | `https://<your-app>/api/mcp/gleeday-affiliates` |
| Gleeday Co-Marketing | `https://<your-app>/api/mcp/gleeday-co-marketing` |
| Gleeday Media & PR | `https://<your-app>/api/mcp/gleeday-media-pr` |
| Gleeday Listing | `https://<your-app>/api/mcp/gleeday-listing` |

The Bots page shows each bot's address on its card.

1. Open the bot's chat in Grok and say:
   > Add the custom MCP server https://&lt;your-app&gt;/api/mcp/&lt;bot-address&gt; and name it "Gleeday Ops – &lt;bot name&gt;".
2. Grok opens a sign-in. Sign in to Gleeday Operations, choose **that same bot** under **Act as**, and click **Allow**.
3. Ask the bot: `Call whoAmI on Gleeday Ops`. It must answer with its own name and channels. A channel bot sees 16 tools; only Soled (coordinator) sees 19.

Repeat for each bot, choosing the matching bot each time.

> **Important: Grok's connectors may be shared across your bots.** The Grok Bot wiki says connected plugins are account-wide. If that's true for your account, every bot could see all five "Gleeday Ops" connectors. The server still limits each connector to its own bot's channels and permissions, and nothing outward-facing happens without your approval. But a bot could use the wrong connector by mistake. Each bot's instructions (below) name the one connector it must use. If Grok lets you restrict a plugin to one bot (Manage plugins), do that.

You can see and disconnect connections under **Bots → Connector connections**.

## Step 3: Let the app wake each bot (webhooks)

1. In each bot's chat, ask:
   > Create a routine called "Gleeday Ops work" with a webhook trigger, using the instruction I'll paste next.

   Paste that bot's instruction from [`docs/bots/ROUTINE_INSTRUCTIONS.md`](bots/ROUTINE_INSTRUCTIONS.md).
2. Open the routine on desktop. The **Webhook** section shows **POST to** (a URL) and **key**.
3. In **Vercel → Settings → Environment Variables**, add two private variables per bot:

| Bot | URL variable | Key variable |
|---|---|---|
| Soled | `SOLED_URL` | `SOLED_TOKEN` |
| Gleeday affiliates | `GLEEDAY_AFFILIATES_URL` | `GLEEDAY_AFFILIATES_TOKEN` |
| Gleeday Co-Marketing | `GLEEDAY_CO_MARKETING_URL` | `GLEEDAY_CO_MARKETING_TOKEN` |
| Gleeday Media & PR | `GLEEDAY_MEDIA_PR_URL` | `GLEEDAY_MEDIA_PR_TOKEN` |
| Gleeday Listing | `GLEEDAY_LISTING_URL` | `GLEEDAY_LISTING_TOKEN` |

4. Redeploy.

The app then sends `{"source":"gleeday-operations","event":"task.available","task_id":"…","kind":"…"}` with `Authorization: Bearer <key>`. A `200` means Grok started a run. **Bots → Recent notifications** shows each one. Grok limits runs to 200 per routine per hour.

Without webhooks, bots only work when you or a schedule start them. You can also give each routine a schedule (at least 5 minutes apart) as a safety net.

## MCP tools (contract v1)

| Tool | Who | Purpose |
|---|---|---|
| `whoAmI` | all | Identity, role, channels, permissions |
| `listTasks(mine?, channel?, limit?, cursor?)` | all | Claimable tasks, or your claimed ones |
| `claimTask(taskId, leaseDuration?)` | all | Atomic claim; returns `lease_token` |
| `heartbeat(taskId, leaseToken)` | all | Extend the lease |
| `getContext(opportunityId)` | all | Partner record, timeline with sources, offers, approvals |
| `searchOpportunities(channel?, stage?, query?)` | all | Find partners in your channels (`stage: "none"` = not yet contacted) |
| `createProspect(channel, externalRef, prospect)` | all | Add a new not-yet-contacted prospect; never merges on names |
| `appendActivity(sourceId, externalEventId, evidence)` | all | Record what really happened (idempotent) |
| `setStage(opportunityId, stage, evidenceEventId)` | all | Stage move with proof |
| `setMilestone(opportunityId, milestone, evidenceEventId)` | all | Program milestone with proof (e.g. joined_impact) |
| `proposeAction(…exactPayload)` → `requestApproval` | all | Ask you to approve the exact email, terms or spend |
| `startApprovedAction` → `reportActionOutcome` | senders | Carry out an approved action once; report the Gmail message id |
| `reportTaskResult` / `reportBlocked` | all | Finish or stop a task |
| `getOverview`, `createTask`, `assignTask` | Soled | Coordinate the team |

Errors: `unauthorized`, `forbidden`, `not_found`, `conflict`, `lease_expired`, `invalid_input`, `not_executable`, `rate_limited`, `internal`.

## Other kinds of bots

Claude routines work too. Add a claude.ai custom connector with the same URL; for webhooks, use the routine's API trigger URL and token in the same `<NAME>_URL` / `<NAME>_TOKEN` variables. Scripts can use a token from the Bots page (`Authorization: Bearer …`).

## What is verified and what isn't

- **Verified by automated tests:** every tool, scope, leases, single execution, approvals, OAuth sign-in and token rotation, the Grok webhook format, and Grok's session-reuse quirk (missing `MCP-Protocol-Version` header).
- **Verified in a browser and over real HTTP** (local demo): token and connector onboarding.
- **Not yet verified:** a real Grok bot connecting to the deployed app. That's the first authorized end-to-end test, once the app is deployed and you can sign in.
