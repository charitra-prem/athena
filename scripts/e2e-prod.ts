// End-to-end test against the deployed broker. Forges envelopes (POSTs to
// /api/wake), instructs the live agent to write specific markers into its
// /memory/ tree, then reads them back from Vercel Blob to confirm the full
// roundtrip — hydrate → agent run → dehydrate.
//
// Uses two synthetic orgs (TEAM_A, TEAM_B) and two synthetic users
// (USER_ALICE, USER_BOB) to exercise RBAC.
//
// Run: npx tsx --env-file=.env scripts/e2e-prod.ts
import { list, del } from "@vercel/blob";
import { kv } from "../lib/kv.js";

const DEPLOY =
  process.env.DEPLOY_URL ??
  "https://cf-vercel-sandbox-demo-4sv0erpi2-prem-ai-main.vercel.app";
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN!;
const INGEST_SECRET = process.env.INGEST_SECRET ?? "";

const TEAM_A = "T_E2E_A";
const TEAM_B = "T_E2E_B";
const USER_ALICE = "U_ALICE";
const USER_BOB = "U_BOB";
const CHANNEL = "C_E2E_TEST";
const CLERK_USER_ALICE = "user_clerk_test_alice";

const ORG_A = `slack:${TEAM_A}`;
const ORG_B = `slack:${TEAM_B}`;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(label: string) { console.log(`  ✓ ${label}`); passed++; }
function fail(label: string, detail?: string) {
  console.log(`  ✗ ${label}` + (detail ? `\n      ${detail}` : ""));
  failed++; failures.push(label);
}

function uniq() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function envelope(team: string, user: string, prompt: string) {
  const ts = `${Date.now()}.${Math.floor(Math.random() * 1e6).toString().padStart(6, "0")}`;
  return {
    source: "manual",                            // non-slack → non-streaming path
    type: "test",
    threadId: `slack:${team}:${CHANNEL}:${ts}`,
    resourceId: `slack:${team}:${CHANNEL}`,
    orgId: `slack:${team}`,
    data: { channel: CHANNEL, user, text: prompt, team },
  };
}

async function wake(env: ReturnType<typeof envelope>): Promise<any> {
  const r = await fetch(`${DEPLOY}/api/wake`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(INGEST_SECRET ? { "x-ingest-secret": INGEST_SECRET } : {}),
    },
    body: JSON.stringify(env),
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}

async function readBlob(key: string): Promise<string | null> {
  const r = await list({ prefix: key, token: BLOB_TOKEN });
  const exact = r.blobs.find((b) => b.pathname === key);
  if (!exact) return null;
  return await fetch(exact.url, { cache: "no-store" }).then((x) => x.text());
}

async function listOrg(orgId: string): Promise<string[]> {
  const r = await list({ prefix: `orgs/${orgId}/`, token: BLOB_TOKEN });
  return r.blobs.map((b) => b.pathname).sort();
}

async function nukeOrg(orgId: string) {
  const r = await list({ prefix: `orgs/${orgId}/`, token: BLOB_TOKEN });
  for (const b of r.blobs) await del(b.url, { token: BLOB_TOKEN });
}

async function nukeLinks() {
  for (const t of [TEAM_A, TEAM_B]) {
    await kv.del(`org-link:slack:${t}`).catch(() => {});
    for (const u of [USER_ALICE, USER_BOB]) {
      await kv.del(`user-link:slack:${t}:${u}`).catch(() => {});
    }
    await kv.del(`sandbox:slack:${t}:${CHANNEL}:1234567890.000000`).catch(() => {});
  }
}

// Pin the agent to a deterministic action via the prompt.
function writeFilePrompt(absPath: string, content: string) {
  return (
    `INSTRUCTIONS: Call the \`write\` tool exactly once with these EXACT arguments, ` +
    `then stop:\n` +
    `  path: ${absPath}\n` +
    `  content: ${content}\n` +
    `Do not use bash. Do not call any other tools. After the write returns, ` +
    `emit a single one-line confirmation as plain text and exit.`
  );
}

async function main() {
  console.log(`[e2e] DEPLOY=${DEPLOY}\n[e2e] cleaning previous state…`);
  await nukeLinks();
  await nukeOrg(ORG_A);
  await nukeOrg(ORG_B);

  // ─── 1. Cold write into org A (anonymous user) ─────────────────────
  console.log("\n[1] org A: anonymous agent writes /memory/org/facts.md");
  const markerA1 = `MARKER_A1_${uniq()}`;
  let r1 = await wake(
    envelope(TEAM_A, USER_ALICE, writeFilePrompt("/vercel/sandbox/memory/org/facts.md", markerA1)),
  );
  if (r1.status !== 200) {
    fail(`wake returned ${r1.status}`, JSON.stringify(r1.body).slice(0, 300));
  } else {
    ok("wake returned 200");
    console.log(`     reused=${r1.body.reused} dirty=${r1.body.dirty} exit=${r1.body.exitCode} ms=${r1.body.totalMs}`);
    const got = await readBlob(`orgs/${ORG_A}/org/facts.md`);
    got?.includes(markerA1)
      ? ok(`blob orgs/${ORG_A}/org/facts.md contains marker`)
      : fail(`blob orgs/${ORG_A}/org/facts.md missing marker`, `got: ${got?.slice(0, 80) ?? "(null)"}`);
  }

  // ─── 2. Same org, NEW thread, no user-link: should see org facts ───
  console.log("\n[2] org A new thread: CONTEXT inlines the marker we just wrote");
  const probeKeyA = `PROBE_A_${uniq()}`;
  const r2 = await wake(
    envelope(
      TEAM_A,
      USER_ALICE,
      `INSTRUCTIONS: Call \`write\` once with path=/vercel/sandbox/memory/org/probe-${probeKeyA}.md ` +
        `and content=<contents-of-org-facts>. To find <contents-of-org-facts>, first call \`read\` ` +
        `on path=/vercel/sandbox/memory/CONTEXT.md and copy the line BELOW the "## Org" heading into ` +
        `the content (just that line). Then stop.`,
    ),
  );
  if (r2.status !== 200) {
    fail(`wake returned ${r2.status}`, JSON.stringify(r2.body).slice(0, 300));
  } else {
    ok(`wake returned 200 (reused=${r2.body.reused})`);
    const probe = await readBlob(`orgs/${ORG_A}/org/probe-${probeKeyA}.md`);
    probe?.includes(markerA1)
      ? ok("CONTEXT.md (read by agent) contained the prior marker")
      : fail(
          "CONTEXT.md did not include the prior org facts",
          `probe content: ${probe?.slice(0, 200) ?? "(null)"}`,
        );
  }

  // ─── 3. Cross-org isolation: org B does NOT see org A's facts ──────
  console.log("\n[3] org B (different team): CONTEXT must NOT contain org A's marker");
  const probeKeyB = `PROBE_B_${uniq()}`;
  const r3 = await wake(
    envelope(
      TEAM_B,
      USER_BOB,
      `INSTRUCTIONS: Call \`read\` on /vercel/sandbox/memory/CONTEXT.md. ` +
        `Then call \`write\` once with path=/vercel/sandbox/memory/org/probe-${probeKeyB}.md ` +
        `and content set to the ENTIRE contents of CONTEXT.md. Then stop.`,
    ),
  );
  if (r3.status !== 200) {
    fail(`wake org B returned ${r3.status}`, JSON.stringify(r3.body).slice(0, 300));
  } else {
    ok(`wake (org B) returned 200`);
    const probe = await readBlob(`orgs/${ORG_B}/org/probe-${probeKeyB}.md`);
    if (probe == null) {
      fail("org B probe file missing in blob");
    } else if (probe.includes(markerA1)) {
      fail("CROSS-ORG LEAK: org B agent saw org A's marker", probe.slice(0, 300));
    } else {
      ok("no cross-org leak: org B CONTEXT did NOT contain org A's marker");
    }
    // Verify org B's blob doesn't contain any orgs/T_E2E_A/* listed
    const orgBListing = await listOrg(ORG_B);
    const aPaths = orgBListing.filter((p) => p.includes(TEAM_A));
    aPaths.length === 0
      ? ok("org B blob namespace is clean of org A paths")
      : fail("org A paths leaked into org B namespace", aPaths.join(","));
  }

  // ─── 4. User-tier isolation: anonymous cannot write user-tier ──────
  console.log("\n[4] anonymous user attempts to write /memory/users/X/ → dehydrate must drop it");
  const fakeUserPath = `/vercel/sandbox/memory/users/some_clerk_user/secret.md`;
  const markerNope = `SHOULD_NOT_LAND_${uniq()}`;
  const r4 = await wake(
    envelope(TEAM_A, USER_ALICE, writeFilePrompt(fakeUserPath, markerNope)),
  );
  if (r4.status !== 200) {
    fail(`wake returned ${r4.status}`, JSON.stringify(r4.body).slice(0, 200));
  } else {
    ok("wake returned 200 (write attempt accepted by agent)");
    const got = await readBlob(`orgs/${ORG_A}/users/some_clerk_user/secret.md`);
    got == null
      ? ok("user-tier blob NOT created (canAccess denied dehydrate)")
      : fail("PRIVACY VIOLATION: anon-written user-tier file reached blob", got.slice(0, 200));
  }

  // ─── 5. Linked user CAN write own user tier ────────────────────────
  console.log("\n[5] link Alice → user-tier write succeeds, lands at her clerk_user_id path");
  await kv.set(`user-link:${ORG_A}:${USER_ALICE}`, CLERK_USER_ALICE);
  const markerAlice = `ALICE_PRIVATE_${uniq()}`;
  const r5 = await wake(
    envelope(
      TEAM_A,
      USER_ALICE,
      writeFilePrompt(
        `/vercel/sandbox/memory/users/${CLERK_USER_ALICE}/facts.md`,
        markerAlice,
      ),
    ),
  );
  if (r5.status !== 200) {
    fail(`wake returned ${r5.status}`, JSON.stringify(r5.body).slice(0, 200));
  } else {
    ok("wake returned 200");
    const got = await readBlob(`orgs/${ORG_A}/users/${CLERK_USER_ALICE}/facts.md`);
    got?.includes(markerAlice)
      ? ok(`user-tier blob landed at orgs/${ORG_A}/users/${CLERK_USER_ALICE}/facts.md`)
      : fail("Alice's user-tier write did not land", got?.slice(0, 200) ?? "(null)");
  }

  // ─── 6. Linked user CANNOT write OTHER user's tier ─────────────────
  console.log("\n[6] linked Alice tries to write a different user's tier → canAccess denies");
  const otherUserPath = `/vercel/sandbox/memory/users/some_OTHER_clerk_user/secret.md`;
  const markerHack = `HACK_ATTEMPT_${uniq()}`;
  const r6 = await wake(
    envelope(TEAM_A, USER_ALICE, writeFilePrompt(otherUserPath, markerHack)),
  );
  if (r6.status !== 200) {
    fail(`wake returned ${r6.status}`, JSON.stringify(r6.body).slice(0, 200));
  } else {
    ok("wake returned 200");
    const got = await readBlob(`orgs/${ORG_A}/users/some_OTHER_clerk_user/secret.md`);
    got == null
      ? ok("foreign user-tier write blocked at dehydrate")
      : fail("PRIVACY VIOLATION: Alice wrote to another user's tier", got.slice(0, 200));
  }

  // ─── 7. Unlink Alice → next event no longer sees her user-tier ─────
  console.log("\n[7] unlink Alice → her user-tier disappears from CONTEXT");
  await kv.del(`user-link:${ORG_A}:${USER_ALICE}`);
  const probeKey7 = `POST_UNLINK_${uniq()}`;
  const r7 = await wake(
    envelope(
      TEAM_A,
      USER_ALICE,
      `INSTRUCTIONS: Call \`read\` on /vercel/sandbox/memory/CONTEXT.md. ` +
        `Then call \`write\` once with path=/vercel/sandbox/memory/org/probe-${probeKey7}.md ` +
        `and content=<entire CONTEXT.md contents>. Then stop.`,
    ),
  );
  if (r7.status !== 200) {
    fail(`wake returned ${r7.status}`, JSON.stringify(r7.body).slice(0, 200));
  } else {
    ok("wake returned 200");
    const probe = await readBlob(`orgs/${ORG_A}/org/probe-${probeKey7}.md`);
    if (probe == null) {
      fail("post-unlink probe file missing");
    } else if (probe.includes(markerAlice) || probe.includes(CLERK_USER_ALICE)) {
      fail("UNLINK FAILED: user-tier still visible after kv.del", probe.slice(0, 300));
    } else {
      ok("after unlink, CONTEXT.md no longer mentions Alice's user-tier");
    }
  }

  // ─── done ──────────────────────────────────────────────────────────
  console.log("\n[e2e] cleaning up…");
  await nukeLinks();
  await nukeOrg(ORG_A);
  await nukeOrg(ORG_B);

  console.log(`\n[e2e] ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("failures:");
    for (const f of failures) console.log("  - " + f);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("[e2e] crashed:", e);
  process.exit(2);
});
