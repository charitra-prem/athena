// Sandbox spawn core. The ONLY place that knows about Vercel Sandbox / agent.ts.
// Every source adapter eventually funnels through here.
import { Sandbox } from "@vercel/sandbox";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ms from "ms";
import { cleanFetch } from "./clean-fetch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_CODE = readFileSync(join(__dirname, "..", "agent.ts"), "utf8");
// skills/ ships inside the snapshot (see bootstrap.ts). Not uploaded per-spawn.

export type Envelope = {
  source: string;
  type: string;
  data: Record<string, unknown>;
};

export async function spawnSandbox(event: Envelope): Promise<{ sandboxId: string; bootMs: number }> {
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
      COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY ?? "",
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY!,
      AGENT_USER_ID: process.env.AGENT_USER_ID ?? "",
      AGENT_EMAIL: process.env.AGENT_EMAIL ?? "",
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? "",
      SLACK_BOT_USER_ID: process.env.SLACK_BOT_USER_ID ?? "",
      SKILLS_DIR: "/vercel/sandbox/skills",
      EVENT_PAYLOAD: JSON.stringify(event),
    },
    networkPolicy: {
      allow: {
        "openrouter.ai": [], "*.openrouter.ai": [],
        "backend.composio.dev": [], "*.composio.dev": [],
        "slack.com": [], "*.slack.com": [],
        "*.googleapis.com": [],
      },
    },
  });

  await sb.writeFiles([{ path: "agent.ts", content: AGENT_CODE }]);

  await sb.runCommand({
    cmd: "node",
    args: ["--experimental-strip-types", "agent.ts"],
    detached: true,
  });

  return { sandboxId: sb.sandboxId, bootMs: Date.now() - t0 };
}
