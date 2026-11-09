// Browser smoke test over every screen against the local demo stack (tools/dev/local-demo.sh).
// Usage: node tests/e2e/smoke.cjs <screenshot-dir> [deviceScaleFactor]
// Exercises: approve a proposal, record activity, evidence-backed stage change, refused stage
// without evidence, pausing a bot, phone-width layout. Exits non-zero on any page error.
const { chromium } = require("playwright");
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3210";
const OUT = process.argv[2];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, deviceScaleFactor: Number(process.argv[3] || 1) });
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  const check = async (name) => {
    const overlay = await page.evaluate(() => [...document.querySelectorAll("nextjs-portal")].some((el) => /Runtime Error|Unhandled|Build Error|Console Error/.test(el.shadowRoot?.textContent ?? "")));
    const text = await page.locator("body").innerText();
    if (overlay || /Unhandled Runtime Error|Application error/.test(text)) errors.push(`${name}: error overlay`);
  };
  const shot = async (name) => { await check(name); await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true, caret: "initial" }); };

  for (const [name, path] of [["01-today", "/"], ["02-metrics", "/metrics"], ["03-pipeline-affiliates", "/pipelines/affiliates"],
    ["04-pipeline-media", "/pipelines/media_pr"], ["05-approvals", "/approvals"], ["06-tasks", "/tasks"],
    ["07-exceptions", "/exceptions"], ["08-bots", "/bots"], ["09-integrations", "/integrations"], ["10-settings", "/settings"]]) {
    await page.goto(BASE + path);
    await shot(name);
  }

  // Approval flow
  await page.goto(BASE + "/approvals");
  await page.getByText("Send affiliate terms to Harbor Lights Events").click();
  await page.waitForURL(/\/approvals\/[0-9a-f-]{36}$/);
  await shot("11-approval-detail");
  await page.fill("textarea[name=note]", "Looks good");
  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForURL(/ok=Approved/);
  const approvedText = await page.locator("body").innerText();
  if (!approvedText.includes("Approved")) errors.push("approval: not approved");
  if (approvedText.includes("Waiting for you")) errors.push("approval: still pending pill");

  // Partner detail: record activity then move stage using it as evidence
  await page.goto(BASE + "/pipelines/affiliates");
  await page.getByRole("link", { name: /Bright Day Planners/ }).click();
  await page.waitForURL(/\/opportunities\//);
  await page.selectOption("select[name=event_type]", "manual.call");
  await page.fill("textarea[name=summary]", "Call with Ana — interested in a pilot");
  await page.fill("input[name=date]", "2026-11-08");
  await page.getByRole("button", { name: "Record" }).click();
  await page.waitForURL(/ok=Activity/);
  await page.selectOption("select[name=stage]", "interested");
  const evidence = page.locator("select[name=evidence_event_id] option", { hasText: "Call with Ana" });
  await page.selectOption("select[name=evidence_event_id]", await evidence.getAttribute("value"));
  await page.getByRole("button", { name: "Update stage" }).click();
  await page.waitForURL(/ok=Stage/);
  // A stage without evidence must be refused with a readable message
  await page.selectOption("select[name=stage]", "agreed");
  await page.selectOption("select[name=evidence_event_id]", "");
  await page.getByRole("button", { name: "Update stage" }).click();
  await page.waitForURL(/error=/);
  const errText = await page.locator(".flash.bad").innerText();
  if (!errText) errors.push("stage without evidence: no error shown");
  await page.goto(page.url().split("?")[0]);
  await shot("12-partner-detail");

  // Bot pause
  await page.goto(BASE + "/bots");
  const card = page.locator(".card", { hasText: "Media Bot" });
  await card.locator("select[name=status]").selectOption("paused");
  await card.getByRole("button", { name: "Save" }).click();
  await page.waitForURL(/ok=Bot/);

  // Today after changes
  await page.goto(BASE + "/");
  await shot("13-today-after");

  // Phone width
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + "/");
  await shot("14-phone-today");
  const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
  if (scrollW > 395) errors.push(`phone: horizontal scroll ${scrollW}px`);

  console.log(JSON.stringify({ stageError: errText, errors }, null, 2));
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
