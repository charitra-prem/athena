// Manual org-link seeder. Maps a Slack team id to a Clerk org id until the
// full Slack OAuth install callback exists.
//
// Usage: npx tsx --env-file=.env scripts/seed-org-link.ts <slack-team-id> <clerk-org-id>
import { kv } from "../lib/kv.js";

async function main() {
  const [team, orgId] = process.argv.slice(2);
  if (!team || !orgId) {
    console.error("usage: seed-org-link.ts <slack-team-id> <clerk-org-id>");
    process.exit(1);
  }
  const key = `org-link:slack:${team}`;
  await kv.set(key, orgId);
  const readback = await kv.get<string>(key);
  console.log(`wrote ${key} = ${orgId}`);
  console.log(`readback: ${readback}`);
  if (readback !== orgId) {
    console.error("readback mismatch");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
