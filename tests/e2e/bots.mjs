// Browser + real HTTP test of bot onboarding against the local demo stack (tools/dev/local-demo.sh).
// 1. Owner creates a bot token on the Bots page; the bot uses it over HTTP MCP.
// 2. A connector registers via OAuth; the owner approves it for one bot on the consent page;
//    the code is exchanged with PKCE; the access token works over MCP as that bot.
// Usage: node tests/e2e/bots.mjs <screenshot-dir>
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const { Client } = await import(require.resolve("@modelcontextprotocol/sdk/client/index.js"));
const { StreamableHTTPClientTransport } = await import(require.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js"));

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3210";
const OUT = process.argv[2];
const errors = [];

async function mcp(token) {
  const client = new Client({ name: "e2e-bot", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/api/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const text = (r) => JSON.parse(r.content[0].text);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

// 1. Token
await page.goto(`${BASE}/bots`);
const card = page.locator(".card", { hasText: "Affiliate Bot" }).first();
await card.locator("input[name=label]").fill("e2e token");
await card.getByRole("button", { name: "Create token" }).click();
const tokenEl = card.locator("pre.token");
await tokenEl.waitFor();
const token = (await tokenEl.innerText()).trim();
if (!/^gwk_[0-9a-f]{64}$/.test(token)) errors.push(`bad token format: ${token}`);
if (page.url().includes(token)) errors.push("token leaked into URL");
await page.screenshot({ path: `${OUT}/20-bots-token.png`, fullPage: true, caret: "initial" });

const bot = await mcp(token);
const me = text(await bot.callTool({ name: "whoAmI", arguments: {} }));
if (me.name !== "Affiliate Bot") errors.push(`whoAmI: ${JSON.stringify(me)}`);
const tasks = text(await bot.callTool({ name: "listTasks", arguments: {} }));
const scoped = text(await bot.callTool({ name: "listTasks", arguments: { mine: true } }));
await bot.close();

// 2. OAuth connector
const reg = await (await fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "Claude (e2e)", redirect_uris: ["http://localhost:9/callback"] }) })).json();
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const authUrl = `${BASE}/oauth/authorize?` + new URLSearchParams({ response_type: "code", client_id: reg.client_id,
  redirect_uri: "http://localhost:9/callback", code_challenge: challenge, code_challenge_method: "S256", state: "xyz", resource: `${BASE}/api/mcp` });
let redirected = null;
await page.route("http://localhost:9/**", (route) => { redirected = route.request().url(); route.fulfill({ status: 200, body: "ok" }); });
await page.goto(authUrl);
await page.screenshot({ path: `${OUT}/21-connector-consent.png`, fullPage: true, caret: "initial" });
const opts = await page.locator("select[name=worker_id] option").allInnerTexts();
await page.selectOption("select[name=worker_id]", { label: opts.find((o) => o.startsWith("Media Bot")) });
await page.getByRole("button", { name: "Allow" }).click();
await page.waitForURL(/localhost:9\/callback/);
const cb = new URL(redirected ?? page.url());
if (cb.searchParams.get("state") !== "xyz") errors.push("state not returned");
const code = cb.searchParams.get("code");
const tok = await (await fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: "http://localhost:9/callback", client_id: reg.client_id, code_verifier: verifier }) })).json();
if (!tok.access_token) errors.push(`token exchange: ${JSON.stringify(tok)}`);
const connector = await mcp(tok.access_token);
const me2 = text(await connector.callTool({ name: "whoAmI", arguments: {} }));
if (me2.name !== "Media Bot") errors.push(`connector whoAmI: ${JSON.stringify(me2)}`);
await connector.close();

await page.goto(`${BASE}/bots`);
await page.screenshot({ path: `${OUT}/22-bots-connections.png`, fullPage: true, caret: "initial" });
if (!(await page.locator("text=Claude (e2e) → Media Bot").count())) errors.push("connection not listed");

console.log(JSON.stringify({ tokenBot: me.name, queuedTasks: tasks.tasks.length, myClaims: scoped.tasks.length, connectorBot: me2.name, errors }, null, 2));
await browser.close();
process.exit(errors.length ? 1 : 0);
