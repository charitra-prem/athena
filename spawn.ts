// Runs LOCALLY for testing. Wakes a sandbox from snapshot, drops the agent in,
// runs it with an event payload (default test payload), waits, stops.
import { Sandbox } from "@vercel/sandbox";
import { readFileSync } from "node:fs";
import ms from "ms";

const cleanFetch: typeof fetch = (input, init) => {
  const { dispatcher: _, ...rest } = (init ?? {}) as any;
  return fetch(input as any, rest);
};

const code = readFileSync(new URL("./agent.ts", import.meta.url), "utf8");

// Pass a payload as argv[2] (JSON string). Default: simple test event.
const payload =
  process.argv[2] ??
  JSON.stringify({
    triggerSlug: "MANUAL_TEST",
    payload: {
      sender: "test@example.com",
      subject: "[athena] dry run",
      message_text: "Reply briefly to confirm you ran end-to-end.",
      thread_id: "test-thread-123",
    },
  });

const t0 = Date.now();
const sb = await Sandbox.create({
  teamId: process.env.VERCEL_TEAM_ID!,
  projectId: process.env.VERCEL_PROJECT_ID!,
  token: process.env.VERCEL_TOKEN!,
  fetch: cleanFetch,
  source: { type: "snapshot", snapshotId: process.env.SANDBOX_SNAPSHOT_ID! },
  resources: { vcpus: 2 },
  timeout: ms("5m"),
  env: {
    COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY!,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY!,
    AGENT_USER_ID: process.env.AGENT_USER_ID!,
    AGENT_EMAIL: process.env.AGENT_EMAIL!,
    EVENT_PAYLOAD: payload,
  },
  networkPolicy: {
    allow: {
      "openrouter.ai": [], "*.openrouter.ai": [],
      "backend.composio.dev": [], "*.composio.dev": [],
      "registry.npmjs.org": [], "*.npmjs.org": [], "api.vercel.com": [],
    },
  },
});
console.log(`sandbox up in ${Date.now() - t0}ms:`, sb.sandboxId);

await sb.writeFiles([{ path: "agent.ts", content: code }]);

const run = await sb.runCommand({
  cmd: "node",
  args: ["--experimental-strip-types", "agent.ts"],
  stdout: process.stdout,
  stderr: process.stderr,
});
console.log(`agent exit=${run.exitCode}, total ${Date.now() - t0}ms`);

await sb.stop();
