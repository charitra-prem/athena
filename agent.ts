// Runs INSIDE the Vercel Sandbox, ONCE per event. Reads a normalized envelope
// { source, type, threadId, data } from EVENT_PAYLOAD, acts, exits.
//
// Slack-events path: streams the agent's response live via Slack's
// chat.startStream / chat.appendStream / chat.stopStream API. No reply tool
// needed — the agent's text IS the stream.
// Non-Slack sources: fall back to `chat.postMessage`-style "reply" tool.
//
// Tools (always available):
//   reply  — post the full final message at once. Used for non-streaming sources.
//   thread — fetch recent thread messages for context.
//   shell  — escape hatch. Skills live in $SKILLS_DIR.
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
  threadId: string;
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

// ── Tools ────────────────────────────────────────────────────────────────
const reply = createTool({
  id: "reply",
  description:
    "Post a full reply at once. ONLY used for non-Slack sources today — Slack " +
    "events stream the response automatically; do not call this tool there.",
  inputSchema: z.object({ text: z.string() }),
  execute: async (input: any) => {
    const text: string = input?.text ?? input?.context?.text ?? "";
    if (isSlack) {
      // Fallback: shouldn't be hit (we stream the response separately), but
      // in case the agent calls it anyway, deliver as plain message.
      const j = await slackApi("chat.postMessage", {
        channel: event.data.channel,
        thread_ts: event.data.thread_id,
        text,
      });
      return j.ok ? { ok: true, ts: j.ts } : { ok: false, error: j.error };
    }
    return { ok: false, error: `unsupported source: ${event.source}` };
  },
});

const thread = createTool({
  id: "thread",
  description: "Fetch recent messages from the current thread for context.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe("Default 20."),
  }),
  execute: async (input: any) => {
    const limit: number = input?.limit ?? input?.context?.limit ?? 20;
    if (isSlack) {
      const j = await slackApi(
        "conversations.replies",
        { channel: event.data.channel, ts: event.data.thread_id, limit: String(limit) },
        true,
      );
      if (!j.ok) return { ok: false, error: j.error };
      const messages = (j.messages ?? []).map((m: any) => ({
        ts: m.ts,
        user: m.user ?? m.bot_id ?? null,
        text: m.text,
      }));
      return { ok: true, messages };
    }
    return { ok: false, error: `unsupported source: ${event.source}` };
  },
});

const shell = createTool({
  id: "shell",
  description:
    "Run a bash command. Use for anything not covered by streaming reply or thread — " +
    "reactions, user lookups, cross-channel posts, file attachments. Skills live in " +
    "$SKILLS_DIR (cat $SKILLS_DIR/<name>/SKILL.md). 20s timeout.",
  inputSchema: z.object({ cmd: z.string() }),
  execute: async (input: any) => {
    const cmd: string = input?.cmd ?? input?.context?.cmd ?? "";
    console.log(`[shell] $ ${cmd}`);
    try {
      const { stdout, stderr } = await exec(cmd, {
        env: process.env,
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
        shell: "/bin/bash",
      });
      return { stdout, stderr, exit: 0 };
    } catch (e: any) {
      return {
        stdout: e?.stdout ?? "",
        stderr: e?.stderr ?? e?.message ?? "",
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
        lastMessages: 10,
        semanticRecall: { topK: 3, messageRange: 2 },
        workingMemory: { enabled: true },
      },
    })
  : undefined;

// ── Instructions (delivery-aware) ────────────────────────────────────────
const instructions = `You are Athena. You wake from one external event, act once, then exit.

The event envelope is in your prompt: { source, type, threadId, data }.

${isSlack
  ? `DELIVERY: your response text is automatically STREAMED to the user as you
generate it. Do NOT call any "reply" tool — your message body IS the response.`
  : `DELIVERY: call \`reply(text)\` once with your final response. The framework
delivers it to the user.`}

Tools:
  • thread(limit?)  — fetch recent messages in the current thread for context.
  • shell(cmd)      — escape hatch for anything else (reactions, user lookups,
                      cross-channel posts, attachments, etc.). Skills live in
                      $SKILLS_DIR; \`cat $SKILLS_DIR/<name>/SKILL.md\` tells
                      you how to invoke each.

Rules:
  1. For typical mentions/DMs, just generate the response text. Don't inspect
     skills when a plain reply is enough.
  2. Use thread first only if you need conversation context to answer well.
  3. Use shell only when streaming text and thread can't do the job.
  4. Never reply to your own messages (data.user / data.bot_id). The adapter
     already filters self-events but verify if in doubt.
  5. Be concise. Markdown is rendered.`;

const tools = isSlack ? { thread, shell } : { reply, thread, shell };

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
    resourceId: "athena",
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
    resourceId: "athena",
  });
  console.log("[agent] done:", r.text.slice(0, 400));
}
