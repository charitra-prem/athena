// Runs INSIDE the Vercel Sandbox, ONCE per event. Reads a normalized envelope
// { source, type, threadId, data } from EVENT_PAYLOAD, acts, exits.
//
// Slack-events path: streams the agent's response live via Slack's
// chat.startStream / chat.appendStream / chat.stopStream API. The agent's
// text IS the delivery — no reply tool needed.
// Non-Slack sources: agent text is generated, logged, and (today) discarded.
// When a new source adapter lands, wire its delivery here.
//
// Memory has two scopes:
//   - threadId   = one conversation (e.g. one Slack thread)
//   - resourceId = the project around it (e.g. the channel) — shared by every
//                  thread in the same place. workingMemory + semanticRecall
//                  are scoped to the resource, so what Athena learns in one
//                  thread is available in every thread of the same channel.
//
// One tool: bash. Everything beyond "generate text" — thread context,
// file edits, builds, tests, package installs, skills — flows through it.
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { UpstashStore, UpstashVector } from "@mastra/upstash";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execCb);

// ── OpenRouter embedder (AI-SDK-compatible) ──────────────────────────────
const openrouterEmbedder = {
  specificationVersion: "v1" as const,
  provider: "openrouter",
  modelId: "openai/text-embedding-3-small",
  maxEmbeddingsPerCall: 64,
  supportsParallelCalls: true,
  async doEmbed({ values }: { values: string[] }) {
    const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: values }),
    });
    const j = (await r.json()) as any;
    if (j.error) throw new Error(`openrouter embed: ${j.error.message ?? JSON.stringify(j.error)}`);
    return {
      embeddings: j.data.map((d: any) => d.embedding as number[]),
      usage: { tokens: j.usage?.total_tokens ?? 0 },
    };
  },
};

// ── Envelope + slack helpers ─────────────────────────────────────────────
type Envelope = {
  source: string;
  type: string;
  threadId: string;          // "slack:<team>:<channel>:<thread_root>"
  resourceId: string;        // project scope, e.g. "slack:<team>:<channel>"
  data: {
    channel?: string | null;
    thread_id?: string | null;
    user?: string | null;
    text?: string | null;
    team?: string | null;
    [k: string]: unknown;
  };
};

const event = JSON.parse(process.env.EVENT_PAYLOAD ?? "null") as Envelope | null;
if (!event) {
  console.error("no EVENT_PAYLOAD");
  process.exit(1);
}
console.log(`[evt] source=${event.source} type=${event.type}`);

async function slackApi(method: string, params: Record<string, any>, get = false) {
  const url = `https://slack.com/api/${method}` + (get ? `?${new URLSearchParams(params)}` : "");
  const r = await fetch(url, {
    method: get ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    ...(get ? {} : { body: JSON.stringify(params) }),
  });
  return (await r.json()) as { ok: boolean; error?: string; [k: string]: any };
}

const isSlack = event.source.startsWith("slack-");

// ── Tool ─────────────────────────────────────────────────────────────────
// One tool: bash. Replies are streamed (Slack) or returned as text (others).
// Anything else — reading/writing files, running tests, installing packages,
// invoking skills, hitting APIs via curl — goes through bash.
//
// State between calls: the bash tool spawns a new shell per invocation, so
// `cd`, `export`, etc. do NOT persist. Use absolute paths and pass `cwd`.
const BASH_WORK_DIR = "/vercel/sandbox/work";
const BASH_DEFAULT_TIMEOUT_MS = 60_000;
const BASH_MAX_TIMEOUT_MS = 75_000; // sandbox itself dies at SANDBOX_TIMEOUT_MS

const bash = createTool({
  id: "bash",
  description:
    "Run a bash command. Full shell: pipes, redirects, subshells, heredocs, " +
    "globs. Standard tools available (cat, ls, find, grep, sed, awk, git, " +
    "node, npm, python3, curl, jq if installed, etc.). `sudo` works without " +
    "a password — install packages with `sudo dnf install -y <pkg>`. " +
    `Default cwd is ${BASH_WORK_DIR} (auto-created); pass \`cwd\` to override. ` +
    `Default timeout ${BASH_DEFAULT_TIMEOUT_MS / 1000}s (max ${BASH_MAX_TIMEOUT_MS / 1000}s). ` +
    "A fresh shell is spawned per call — `cd` and `export` don't persist; " +
    "use absolute paths or pass `cwd`. Skills under $SKILLS_DIR provide " +
    "higher-level helpers; `cat $SKILLS_DIR/<name>/SKILL.md` for each. " +
    "Returns { stdout, stderr, exit }; output capped at 10MB.",
  inputSchema: z.object({
    cmd: z.string().describe("The bash command to run."),
    cwd: z.string().optional().describe(`Working directory. Default ${BASH_WORK_DIR}.`),
    timeout: z
      .number()
      .int()
      .min(1_000)
      .max(BASH_MAX_TIMEOUT_MS)
      .optional()
      .describe(`Override timeout in ms (default ${BASH_DEFAULT_TIMEOUT_MS}).`),
  }),
  execute: async (input: any) => {
    const ctx = input?.context ?? input ?? {};
    const cmd: string = ctx.cmd ?? "";
    const cwd: string = ctx.cwd ?? BASH_WORK_DIR;
    const timeout: number = ctx.timeout ?? BASH_DEFAULT_TIMEOUT_MS;
    console.log(`[bash] (${cwd}) $ ${cmd}`);
    try {
      // Ensure cwd exists. Cheap; mkdir -p is a no-op when present.
      await exec(`mkdir -p ${JSON.stringify(cwd)}`, { shell: "/bin/bash" });
      const { stdout, stderr } = await exec(cmd, {
        cwd,
        env: process.env,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        shell: "/bin/bash",
      });
      return { stdout, stderr, exit: 0 };
    } catch (e: any) {
      const killed = e?.killed === true || e?.signal === "SIGTERM";
      return {
        stdout: e?.stdout ?? "",
        stderr: (e?.stderr ?? "") + (killed ? `\n[bash] killed after ${timeout}ms` : ""),
        exit: typeof e?.code === "number" ? e.code : 1,
      };
    }
  },
});

// ── Memory ────────────────────────────────────────────────────────────────
const memory = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Memory({
      storage: new UpstashStore({
        id: "athena-store",
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      }),
      vector: new UpstashVector({
        id: "athena-vector",
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      }),
      embedder: openrouterEmbedder as any,
      options: {
        lastMessages: 10,                                          // thread-scoped (always)
        semanticRecall: { topK: 3, messageRange: 2, scope: "resource" },
        workingMemory: { enabled: true, scope: "resource" },
      },
    })
  : undefined;

// ── Instructions (delivery-aware) ────────────────────────────────────────
const instructions = `You are Athena. You wake from one external event, act once, then exit.

The event envelope is in your prompt: { source, type, threadId, resourceId, data }.

DELIVERY: your response text is automatically STREAMED to the user as you
generate it. Just produce the answer as your text — do NOT call any tool
to deliver it.

Tool:
  • bash(cmd, cwd?, timeout?) — full bash with pipes, redirects, heredocs,
    globs. Use it for everything that isn't generating your response: reading
    files, editing code, running tests, installing packages (\`sudo dnf
    install -y <pkg>\`), git operations, hitting APIs with curl, invoking
    skills. \`cd\` and \`export\` do NOT persist between calls — pass \`cwd\`
    instead, and use absolute paths.

Working as a coding agent:
  • Default workdir is /vercel/sandbox/work — clone, edit, build, test there.
  • Read files: \`cat -n path/to/file\`. Search: \`grep -rn 'pat' path\`.
    List: \`ls -la\` or \`find path -type f\`.
  • Edit small changes via heredocs/sed; for big rewrites, write a temp
    script and run it. Always re-read the file after editing to verify.
  • Run tests / lints before claiming success. Capture stderr; non-zero
    exit codes are failures, surface them.
  • Long-running things (installs, builds) can take ~60s. Pass a \`timeout\`
    up to 75000 if you need more, or break work into smaller steps.

Slack / channel actions go through skills:
  • \`cat $SKILLS_DIR/<name>/SKILL.md\` for usage of each skill (slack, etc.).

Rules:
  1. For typical questions, just generate the answer text. Don't reach for
     bash unless you actually need to inspect/change something.
  2. Fetch thread context only if you can't answer well without it.
  3. Never respond to your own messages (data.user / data.bot_id). The
     adapter filters self-events but verify if in doubt.
  4. Be concise. Markdown is rendered.`;

const tools = { bash };

const athena = new Agent({
  name: "athena",
  instructions,
  model: "openrouter/deepseek/deepseek-v3.2",
  tools,
  memory,
});

const prompt = `Event envelope:\n${JSON.stringify(event, null, 2)}`;

// ── Slack streaming path ─────────────────────────────────────────────────
if (isSlack) {
  // 1. Open a live stream message in the thread.
  const start = await slackApi("chat.startStream", {
    channel: event.data.channel,
    thread_ts: event.data.thread_id,
    recipient_team_id: event.data.team,
    recipient_user_id: event.data.user,
  });
  if (!start.ok) {
    console.error(`[stream] startStream failed: ${start.error}`);
    process.exit(1);
  }
  const messageTs = start.ts as string;
  console.log(`[stream] start ts=${messageTs}`);

  // 2. Buffer agent deltas; flush every 80 chars OR 250ms.
  let buf = "";
  let lastFlush = Date.now();
  const flush = async () => {
    if (!buf) return;
    const chunk = buf;
    buf = "";
    const r = await slackApi("chat.appendStream", {
      channel: event.data.channel,
      ts: messageTs,
      markdown_text: chunk,
    });
    if (!r.ok) console.error(`[stream] append failed: ${r.error}`);
    lastFlush = Date.now();
  };

  // 3. Stream from the agent.
  const result = await athena.stream(prompt, {
    maxSteps: 6,
    threadId: event.threadId,
    resourceId: event.resourceId,
  } as any);

  for await (const delta of (result as any).textStream as AsyncIterable<string>) {
    buf += delta;
    if (buf.length >= 80 || Date.now() - lastFlush > 250) await flush();
  }
  await flush();

  // 4. Finalize.
  const stop = await slackApi("chat.stopStream", {
    channel: event.data.channel,
    ts: messageTs,
  });
  console.log(`[stream] stop ok=${stop.ok} err=${stop.error ?? "-"}`);
} else {
  // ── Non-streaming path (non-Slack sources) ────────────────────────────
  const r = await athena.generate(prompt, {
    maxSteps: 6,
    threadId: event.threadId,
    resourceId: event.resourceId,
  });
  console.log("[agent] done:", r.text.slice(0, 400));
}
