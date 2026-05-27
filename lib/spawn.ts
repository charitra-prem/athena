// Sandbox spawn core. The ONLY place that knows about Vercel Sandbox / agent.
//
// Lifecycle per event:
//   1. Look up KV state for envelope.threadId.
//   2. If a live sandbox for this thread is within the keep-alive window,
//      reattach to it ("warm reuse" — ~0 cold-start).
//   3. Otherwise, create a sandbox from the thread's snapshot (or BASE if new).
//   4. Run the agent (awaited; not detached).
//   5. Detect whether the agent modified the filesystem ("dirty").
//   6. If dirty AND agent exited successfully: snapshot the sandbox.
//      Delete the previous per-thread snapshot so we keep at most one.
//   7. Update KV with expiresAt = now + keep-alive window.
//   8. Do NOT explicitly stop the sandbox. Its own timeout > keep-alive
//      window, so it dies on its own after the window expires.
import { Sandbox } from "@vercel/sandbox";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import ms from "ms";
import { cleanFetch } from "./clean-fetch.js";
import { kv } from "./kv.js";
import { resolveIdentity } from "./identity.js";
import { hydrate, dehydrate } from "./memory.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENT_CODE = readFileSync(join(__dirname, "..", ".build", "agent.js"), "utf8");

const BASE_SNAPSHOT = process.env.SANDBOX_SNAPSHOT_ID!;
const KEEP_ALIVE_MS = 5 * 60_000;      // warm-reuse window for follow-ups
const SANDBOX_TIMEOUT_MS = 10 * 60_000; // sandbox hard timeout — must exceed KEEP_ALIVE_MS

export type Envelope = {
  source: string;
  type: string;
  threadId: string;                    // canonical: "<source>:<source-key>"
  resourceId: string;                  // project scope (e.g. "slack:<team>:<channel>")
  orgId: string;                       // org scope (e.g. "slack:<team>")
  data: Record<string, unknown>;
};

type ThreadState = {
  sandboxId?: string;
  expiresAt?: number;
  snapshotId?: string;                 // last thread snapshot (excludes BASE)
};

// ── Vercel REST helper for ops not in the SDK (snapshot delete) ──────────
async function vercelDelete(path: string) {
  const r = await fetch(
    `https://api.vercel.com${path}?teamId=${process.env.VERCEL_TEAM_ID}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` } },
  );
  if (!r.ok && r.status !== 404) {
    throw new Error(`vercel DELETE ${path} → ${r.status}: ${await r.text()}`);
  }
}

async function deleteSnapshot(snapshotId: string): Promise<void> {
  if (snapshotId === BASE_SNAPSHOT) return;          // never touch the base
  try {
    await vercelDelete(`/v1/snapshots/${snapshotId}`);
  } catch (e: any) {
    console.error(`[spawn] delete snapshot ${snapshotId}: ${e?.message ?? e}`);
  }
}

// Touch a marker before agent runs, then `find -newer` to detect dirt.
async function markRunStart(sb: Sandbox): Promise<void> {
  await sb.runCommand({ cmd: "bash", args: ["-c", "touch /tmp/run-start"] });
}

async function detectDirty(sb: Sandbox): Promise<boolean> {
  const r = await sb.runCommand({
    cmd: "bash",
    args: [
      "-c",
      // Check /vercel/sandbox/work + /vercel/sandbox/node_modules + /vercel/sandbox/.git
      // (everything the agent could meaningfully change). Ignore agent.js itself.
      "find /vercel/sandbox/work /vercel/sandbox/node_modules /vercel/sandbox/.git " +
        "-not -path '*/agent.js' -newer /tmp/run-start 2>/dev/null | head -1",
    ],
  });
  const stdout = await r.stdout();
  return stdout.trim().length > 0;
}

// ── Main spawn entry ─────────────────────────────────────────────────────
export async function spawnSandbox(event: Envelope): Promise<{
  sandboxId: string;
  reused: boolean;
  dirty: boolean;
  snapshotId?: string;
  totalMs: number;
  exitCode: number | null;
}> {
  const t0 = Date.now();
  const stateKey = `sandbox:${event.threadId}`;
  const state = (await kv.get<ThreadState>(stateKey)) ?? {};

  // Common sandbox auth
  const auth = {
    teamId: process.env.VERCEL_TEAM_ID!,
    projectId: process.env.VERCEL_PROJECT_ID!,
    token: process.env.VERCEL_TOKEN!,
    fetch: cleanFetch,
  };

  // 1. Try to reuse a live sandbox within the keep-alive window.
  let sb: Sandbox | null = null;
  let reused = false;
  if (state.sandboxId && state.expiresAt && state.expiresAt > Date.now()) {
    try {
      sb = await Sandbox.get({ ...auth, sandboxId: state.sandboxId });
      reused = true;
    } catch {
      sb = null;                       // sandbox died (timeout / crash); fall through
    }
  }

  // 2. Cold path: create from thread snapshot, or BASE if new thread.
  if (!sb) {
    sb = await Sandbox.create({
      ...auth,
      source: { type: "snapshot", snapshotId: state.snapshotId ?? BASE_SNAPSHOT },
      resources: { vcpus: 2 },
      timeout: SANDBOX_TIMEOUT_MS,
      env: {
        COMPOSIO_API_KEY: process.env.COMPOSIO_API_KEY ?? "",
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY!,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
        AGENT_USER_ID: process.env.AGENT_USER_ID ?? "",
        AGENT_EMAIL: process.env.AGENT_EMAIL ?? "",
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN ?? "",
        SLACK_BOT_USER_ID: process.env.SLACK_BOT_USER_ID ?? "",
        UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL ?? "",
        UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN ?? "",
        SKILLS_DIR: "/vercel/sandbox/skills",
        THREAD_ID: event.threadId,
      },
      networkPolicy: {
        allow: {
          "openrouter.ai": [], "*.openrouter.ai": [],
          "api.openai.com": [],
          "backend.composio.dev": [], "*.composio.dev": [],
          "slack.com": [], "*.slack.com": [],
          "*.googleapis.com": [],
          "*.upstash.io": [],
        },
      },
    });
  }

  // Always re-upload agent.js — covers redeploys between reuses (5.7KB, cheap).
  await sb.writeFiles([{ path: "agent.js", content: AGENT_CODE }]);

  // Resolve identity + hydrate durable memory.
  const identity = await resolveIdentity(event);
  const bundle = await hydrate(event, identity);
  if (bundle.files.length > 0) {
    await sb.writeFiles(
      bundle.files.map((f) => ({ path: f.path, content: Buffer.from(f.content) })),
    );
  }

  // 3. Mark start and run the agent.
  await markRunStart(sb);
  const cmd = await sb.runCommand({
    cmd: "node",
    args: ["agent.js"],
    env: { EVENT_PAYLOAD: JSON.stringify(event), THREAD_ID: event.threadId },
  });

  // Push back any memory files the agent modified. Independent of the dirty check
  // for /work — memory has its own persistence (object storage).
  if (cmd.exitCode === 0) {
    try {
      const out = await dehydrate(sb, event, identity, "/tmp/run-start");
      if (out.uploaded > 0) console.log(`[spawn] dehydrate uploaded=${out.uploaded}`);
    } catch (e: any) {
      console.error(`[spawn] dehydrate failed: ${e?.message ?? e}`);
    }
  }

  // 4. Decide whether to snapshot. Skip if reply-only (clean) or agent failed.
  const dirty = cmd.exitCode === 0 ? await detectDirty(sb) : false;
  let newSnapshotId = state.snapshotId;
  if (dirty) {
    const snap = await sb.snapshot();
    newSnapshotId = snap.snapshotId;
    // GC the predecessor so we never accumulate more than one per thread.
    if (state.snapshotId) await deleteSnapshot(state.snapshotId);
  }

  // 5. Persist KV with new keep-alive window. The sandbox keeps running
  //    (its own timeout will reap it eventually).
  await kv.set(
    stateKey,
    {
      sandboxId: sb.sandboxId,
      expiresAt: Date.now() + KEEP_ALIVE_MS,
      snapshotId: newSnapshotId,
    },
    7 * 24 * 60 * 60,                  // KV TTL: 7 days idle = drop thread entirely
  );

  return {
    sandboxId: sb.sandboxId,
    reused,
    dirty,
    snapshotId: newSnapshotId,
    totalMs: Date.now() - t0,
    exitCode: cmd.exitCode,
  };
}
