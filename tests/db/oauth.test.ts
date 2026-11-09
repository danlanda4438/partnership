// OAuth for connector-based bots (e.g. claude.ai custom connectors): register → admin approves
// for ONE bot → code + PKCE → short-lived bot token + rotating refresh token.
import { createHash, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { POST as registerRoute } from "../../apps/web/app/oauth/register/route";
import { POST as tokenRoute } from "../../apps/web/app/oauth/token/route";
import { authenticate } from "../../apps/web/lib/mcp/server";
import { localServiceDb, type ServiceDb } from "../../apps/web/lib/service-db";
import { addMember, asUser, createWorkspace, createWorker, expectPgError } from "./helpers";

let db: ServiceDb;
beforeAll(async () => {
  process.env.GLEEDAY_LOCAL_DB_URL = process.env.TEST_DATABASE_URL;
  db = await localServiceDb(process.env.TEST_DATABASE_URL as string);
});

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(redirect = REDIRECT) {
  const res = await registerRoute(new Request("https://ops.test/oauth/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect] }),
  }));
  return { status: res.status, body: await res.json() };
}

async function token(params: Record<string, string>) {
  const res = await tokenRoute(new Request("https://ops.test/oauth/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString(),
  }));
  return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
}

async function connectFlow() {
  const ws = await createWorkspace();
  const bot = await createWorker(ws.workspaceId, { channelIds: [ws.channels.media_pr], name: "Media Bot" });
  const client = (await register()).body;
  const { verifier, challenge } = pkce();
  const code = (await asUser(ws.ownerId, (q) => q("select public.oauth_authorize($1, $2, $3, $4) as c", [client.client_id, REDIRECT, bot, challenge]))).rows[0].c;
  return { ws, bot, client, verifier, challenge, code };
}

describe("connector OAuth", () => {
  it("issues tokens that act as exactly the approved bot", async () => {
    const f = await connectFlow();
    const t = await token({ grant_type: "authorization_code", code: f.code, redirect_uri: REDIRECT, client_id: f.client.client_id, code_verifier: f.verifier });
    expect(t.status).toBe(200);
    expect(t.cache).toBe("no-store");
    expect(t.body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    const me = await authenticate(db, `Bearer ${t.body.access_token}`);
    expect(me).toMatchObject({ worker_id: f.bot, name: "Media Bot", channels: ["media_pr"] });
  });

  it("requires the right PKCE verifier, client and redirect, and codes are single-use", async () => {
    const f = await connectFlow();
    const base = { grant_type: "authorization_code", code: f.code, redirect_uri: REDIRECT, client_id: f.client.client_id };
    expect((await token({ ...base, code_verifier: pkce().verifier })).body.error).toBe("invalid_grant");
    const f2 = await connectFlow();
    expect((await token({ grant_type: "authorization_code", code: f2.code, redirect_uri: "https://evil.test/cb", client_id: f2.client.client_id, code_verifier: f2.verifier })).body.error).toBe("invalid_grant");

    const f3 = await connectFlow();
    const ok = await token({ grant_type: "authorization_code", code: f3.code, redirect_uri: REDIRECT, client_id: f3.client.client_id, code_verifier: f3.verifier });
    expect(ok.status).toBe(200);
    const replay = await token({ grant_type: "authorization_code", code: f3.code, redirect_uri: REDIRECT, client_id: f3.client.client_id, code_verifier: f3.verifier });
    expect(replay.body.error).toBe("invalid_grant");
    // Code replay is a theft signal: the tokens already issued are revoked.
    expect(await authenticate(db, `Bearer ${ok.body.access_token}`)).toBeNull();
  });

  it("rotates refresh tokens and revokes everything if an old one is reused", async () => {
    const f = await connectFlow();
    const t1 = await token({ grant_type: "authorization_code", code: f.code, redirect_uri: REDIRECT, client_id: f.client.client_id, code_verifier: f.verifier });
    const t2 = await token({ grant_type: "refresh_token", refresh_token: t1.body.refresh_token, client_id: f.client.client_id });
    expect(t2.status).toBe(200);
    expect(t2.body.refresh_token).not.toBe(t1.body.refresh_token);
    expect(await authenticate(db, `Bearer ${t2.body.access_token}`)).not.toBeNull();
    const reuse = await token({ grant_type: "refresh_token", refresh_token: t1.body.refresh_token, client_id: f.client.client_id });
    expect(reuse.body.error).toBe("invalid_grant");
    expect(await authenticate(db, `Bearer ${t2.body.access_token}`)).toBeNull();
    expect((await token({ grant_type: "refresh_token", refresh_token: t2.body.refresh_token, client_id: f.client.client_id })).body.error).toBe("invalid_grant");
  });

  it("an admin can disconnect a connector, which stops its tokens immediately", async () => {
    const f = await connectFlow();
    const t = await token({ grant_type: "authorization_code", code: f.code, redirect_uri: REDIRECT, client_id: f.client.client_id, code_verifier: f.verifier });
    const grants = (await asUser(f.ws.ownerId, (q) => q("select public.ui_connector_grants($1) as r", [f.ws.workspaceId]))).rows[0].r;
    expect(grants[0]).toMatchObject({ client_name: "Claude", worker: "Media Bot", revoked_at: null });
    await asUser(f.ws.ownerId, (q) => q("select public.revoke_connector_grant($1)", [grants[0].id]));
    expect(await authenticate(db, `Bearer ${t.body.access_token}`)).toBeNull();
    expect((await token({ grant_type: "refresh_token", refresh_token: t.body.refresh_token, client_id: f.client.client_id })).body.error).toBe("invalid_grant");
  });

  it("only owners/admins can approve, only for bots in their workspace, and only with PKCE", async () => {
    const ws = await createWorkspace();
    const other = await createWorkspace();
    const member = await addMember(ws.workspaceId, "member");
    const bot = await createWorker(ws.workspaceId);
    const foreignBot = await createWorker(other.workspaceId);
    const client = (await register()).body;
    const { challenge } = pkce();
    const authz = (user: string, worker: string, ch = challenge) =>
      asUser(user, (q) => q("select public.oauth_authorize($1, $2, $3, $4)", [client.client_id, REDIRECT, worker, ch]));
    await expectPgError(authz(member, bot), "not authorized");
    await expectPgError(authz(ws.ownerId, foreignBot), "not authorized");
    await expectPgError(authz(ws.ownerId, bot, "short"), "PKCE");
    await expectPgError(asUser(ws.ownerId, (q) => q("select public.oauth_authorize($1, 'https://evil.test/cb', $2, $3)", [client.client_id, bot, challenge])), "unknown client");
  });

  it("registration accepts only https redirect addresses (or localhost)", async () => {
    expect((await register("http://evil.test/cb")).status).toBe(400);
    expect((await register("http://localhost:3333/callback")).status).toBe(201);
  });
});
