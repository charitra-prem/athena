// Local smoke for hydrate/dehydrate round-trip against the real blob store.
// Seeds a fake org/facts.md + project/facts.md, runs hydrate, prints
// CONTEXT.md. No sandbox involved — just verifies the blob plumbing.
import { put, list, del } from "@vercel/blob";
import { hydrate } from "../lib/memory.js";
import type { Envelope } from "../lib/spawn.js";
import type { Identity } from "../lib/identity.js";

const token = process.env.BLOB_READ_WRITE_TOKEN!;
const ORG = "slack:T_SMOKE";
const CHANNEL = "C_SMOKE";

async function cleanup() {
  const r = await list({ prefix: `orgs/${ORG}/`, token });
  for (const b of r.blobs) await del(b.url, { token });
}

async function seed() {
  await put(
    `orgs/${ORG}/org/facts.md`,
    "Prem uses TypeScript on Vercel.",
    { access: "public", token, allowOverwrite: true, addRandomSuffix: false },
  );
  await put(
    `orgs/${ORG}/projects/${CHANNEL}/facts.md`,
    "This channel is for the smoke test.",
    { access: "public", token, allowOverwrite: true, addRandomSuffix: false },
  );
  await put(
    `orgs/${ORG}/org/log.jsonl`,
    JSON.stringify({ ts: Date.now(), fact: "seeded" }) + "\n",
    { access: "public", token, allowOverwrite: true, addRandomSuffix: false },
  );
}

const env: Envelope = {
  source: "slack-events",
  type: "app_mention",
  threadId: `${ORG}:${CHANNEL}:1234567890.000000`,
  resourceId: `${ORG}:${CHANNEL}`,
  orgId: ORG,
  data: { channel: CHANNEL, user: "U_SMOKE", text: "hi", team: "T_SMOKE" },
};

const id: Identity = { orgId: ORG, userId: null };

await cleanup();
console.log("[smoke] seeding…");
await seed();

console.log("[smoke] hydrating…");
const { files } = await hydrate(env, id);
console.log(`[smoke] got ${files.length} file(s):`);
for (const f of files) console.log("  " + f.path + ` (${f.content.length}B)`);

const ctx = files.find((f) => f.path === "memory/CONTEXT.md");
if (!ctx) throw new Error("no CONTEXT.md in bundle");
console.log("\n----- CONTEXT.md -----\n" + ctx.content + "----- end -----\n");

const orgFacts = files.find((f) => f.path === "memory/org/facts.md");
if (!orgFacts) throw new Error("org/facts.md missing from bundle");
if (!orgFacts.content.includes("Prem uses TypeScript")) {
  throw new Error("org/facts.md content didn't round-trip");
}

console.log("[smoke] cleanup…");
await cleanup();
console.log("[smoke] ok");
