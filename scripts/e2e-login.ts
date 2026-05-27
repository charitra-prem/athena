// End-to-end login-flow test against deployed prod.
// Verifies:
//   1. /api/sources/slack-command rejects unsigned POST (403)
//   2. /api/sources/slack-command accepts a properly-signed slash command and
//      returns an ephemeral message containing the sign-in URL
//   3. /api/sign-in renders HTML containing the slack id we passed
//   4. /api/clerk-webhook rejects unsigned payload (400)
//   5. /api/clerk-webhook accepts a properly-signed user.created event and
//      writes the user-link mapping into KV
//
// Run: SLACK_SIGNING_SECRET=... CLERK_WEBHOOK_SECRET=... DEPLOY_URL=... npx tsx --env-file=.env scripts/e2e-login.ts
import { createHmac } from "node:crypto";
import { Webhook } from "svix";
import { kv } from "../lib/kv.js";

const DEPLOY = process.env.DEPLOY_URL ?? "https://cf-vercel-sandbox-demo-9q3esklj6-prem-ai-main.vercel.app";
const SIGN_SECRET = process.env.TEST_SLACK_SIGNING_SECRET!;
const WEBHOOK_SECRET = process.env.TEST_CLERK_WEBHOOK_SECRET!;
if (!SIGN_SECRET || !WEBHOOK_SECRET) {
  console.error("set TEST_SLACK_SIGNING_SECRET and TEST_CLERK_WEBHOOK_SECRET in env");
  process.exit(2);
}

const TEAM = "T05BRBNL867";
const SLACK_USER = "U_LOGIN_TEST";
const CLERK_USER = "user_clerk_login_test_" + Math.random().toString(36).slice(2, 8);

let passed = 0;
let failed = 0;
function ok(s: string) { console.log(`  ✓ ${s}`); passed++; }
function bad(s: string, d?: string) { console.log(`  ✗ ${s}` + (d ? `\n      ${d}` : "")); failed++; }

function signSlack(body: string): { ts: string; sig: string } {
  const ts = Math.floor(Date.now() / 1000).toString();
  const base = `v0:${ts}:${body}`;
  const sig = "v0=" + createHmac("sha256", SIGN_SECRET).update(base).digest("hex");
  return { ts, sig };
}

async function main() {
  await kv.del(`user-link:slack:${TEAM}:${SLACK_USER}`).catch(() => {});

  // ─── 1. unsigned slash command rejected ────────────────────────────
  console.log("\n[1] slash command rejects unsigned POST");
  const r1 = await fetch(`${DEPLOY}/api/sources/slack-command`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "command=%2Fathena-login",
  });
  r1.status === 403 ? ok("403 forbidden on unsigned") : bad(`expected 403, got ${r1.status}`);

  // ─── 2. properly-signed slash command returns ephemeral with URL ───
  console.log("\n[2] signed /athena-login → ephemeral sign-in message");
  const body = `command=%2Fathena-login&team_id=${TEAM}&user_id=${SLACK_USER}&user_name=loginflow&channel_id=C0TEST`;
  const { ts, sig } = signSlack(body);
  const r2 = await fetch(`${DEPLOY}/api/sources/slack-command`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sig,
    },
    body,
  });
  if (r2.status !== 200) {
    bad(`expected 200 got ${r2.status}`, await r2.text());
  } else {
    const j: any = await r2.json();
    j.response_type === "ephemeral" ? ok("response_type=ephemeral") : bad(`response_type=${j.response_type}`);
    const text: string = j.text ?? "";
    text.includes("Sign in here") ? ok("message has 'Sign in here' link text") : bad("missing link label");
    const expectedFragment = `slack=${encodeURIComponent(`${TEAM}:${SLACK_USER}`)}`;
    text.includes(expectedFragment)
      ? ok(`URL contains slack=${TEAM}:${SLACK_USER}`)
      : bad("URL missing slack identity", text);
  }

  // ─── 3. sign-in page renders with slack id ─────────────────────────
  console.log("\n[3] /api/sign-in renders HTML with slack id");
  const r3 = await fetch(`${DEPLOY}/api/sign-in?slack=${encodeURIComponent(`${TEAM}:${SLACK_USER}`)}`);
  if (r3.status !== 200) {
    bad(`expected 200 got ${r3.status}`);
  } else {
    const html = await r3.text();
    html.includes(`${TEAM}:${SLACK_USER}`) ? ok("HTML includes slack id") : bad("HTML missing slack id");
    html.includes("clerk.accounts.dev") ? ok("links to Clerk frontend API") : bad("missing Clerk URL");
  }

  // ─── 4. webhook rejects unsigned ───────────────────────────────────
  console.log("\n[4] clerk-webhook rejects unsigned POST");
  const r4 = await fetch(`${DEPLOY}/api/clerk-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "user.created" }),
  });
  r4.status === 400 ? ok("400 bad signature") : bad(`expected 400, got ${r4.status}`);

  // ─── 5. webhook accepts signed user.created → writes user-link ─────
  console.log("\n[5] signed user.created webhook → KV user-link mapping");
  const payload = JSON.stringify({
    type: "user.created",
    data: {
      id: CLERK_USER,
      unsafe_metadata: { slack_user_id: `${TEAM}:${SLACK_USER}` },
    },
  });
  const wh = new Webhook(WEBHOOK_SECRET);
  const msgId = "msg_login_test";
  const whTs = new Date();
  const whSig = wh.sign(msgId, whTs, payload);
  const r5 = await fetch(`${DEPLOY}/api/clerk-webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": msgId,
      "svix-timestamp": Math.floor(whTs.getTime() / 1000).toString(),
      "svix-signature": whSig,
    },
    body: payload,
  });
  if (r5.status !== 200) {
    bad(`expected 200, got ${r5.status}`, await r5.text());
  } else {
    ok("webhook returned 200");
    // Give KV a beat to settle (Upstash is fast; <100ms typical)
    await new Promise((r) => setTimeout(r, 200));
    const mapped = await kv.get<string>(`user-link:slack:${TEAM}:${SLACK_USER}`);
    mapped === CLERK_USER
      ? ok(`KV user-link mapped to ${CLERK_USER}`)
      : bad("KV mapping not written", `got: ${mapped ?? "(null)"}`);
  }

  // cleanup
  await kv.del(`user-link:slack:${TEAM}:${SLACK_USER}`).catch(() => {});

  console.log(`\n[e2e-login] ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[e2e-login] crashed:", e);
  process.exit(2);
});
