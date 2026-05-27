// Runs INSIDE the Vercel Sandbox, ONCE per event. Reads a normalized envelope
// { source, type, data } from EVENT_PAYLOAD, acts, exits.
//
// Tools (priority order):
//   reply   — post a reply in-thread. The 99% case.
//   thread  — fetch recent messages in the current thread for context.
//   shell   — escape hatch. Skills live in $SKILLS_DIR (slack, google, …).
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { UpstashStore, UpstashVector } from "@mastra/upstash";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execCb);

type Envelope = {
  source: string;
  type: string;
  threadId: string;
  data: {
    channel?: string | null;
    thread_id?: string | null;
    user?: string | null;
    text?: string | null;
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

const reply = createTool({
  id: "reply",
  description:
    "Post a reply in-thread to whoever triggered this event. Use this for normal responses.",
  inputSchema: z.object({
    text: z.string().describe("The reply text. Be concise."),
  }),
  execute: async (input: any) => {
    const text: string = input?.text ?? input?.context?.text ?? "";
    if (event.source.startsWith("slack-")) {
      const j = await slackApi("chat.postMessage", {
        channel: event.data.channel,
        thread_ts: event.data.thread_id,
        text,
      });
      console.log(`[reply] slack ok=${j.ok} ts=${j.ts ?? "-"} err=${j.error ?? "-"}`);
      return j.ok ? { ok: true, ts: j.ts } : { ok: false, error: j.error };
    }
    return { ok: false, error: `unsupported source: ${event.source}` };
  },
});

const thread = createTool({
  id: "thread",
  description:
    "Fetch recent messages from the current thread for context. Returns up to `limit` messages.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).optional().describe("Default 20."),
  }),
  execute: async (input: any) => {
    const limit: number = input?.limit ?? input?.context?.limit ?? 20;
    if (event.source.startsWith("slack-")) {
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
      console.log(`[thread] slack got ${messages.length} messages`);
      return { ok: true, messages };
    }
    return { ok: false, error: `unsupported source: ${event.source}` };
  },
});

const shell = createTool({
  id: "shell",
  description:
    "Run a shell command (bash -c). Use ONLY when reply/thread are insufficient — e.g., " +
    "reacting with an emoji, fetching user info, posting to a different channel, attaching " +
    "files, anything else. Skills live in $SKILLS_DIR (e.g. slack); read $SKILLS_DIR/<name>/SKILL.md " +
    "for usage. Returns { stdout, stderr, exit }. 20s timeout.",
  inputSchema: z.object({
    cmd: z.string(),
  }),
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

const instructions = `You are Athena. You wake from one external event, act once, then exit.

The event envelope is in your prompt: { source, type, data }.

You have three tools:
  • reply(text)     — post a reply in-thread to whoever triggered this event.
  • thread(limit?)  — fetch recent messages in the current thread for context.
  • shell(cmd)      — escape hatch for anything else (reactions, user lookups,
                      cross-channel posts, file attachments, etc.). Skills are
                      in $SKILLS_DIR; \`cat $SKILLS_DIR/<name>/SKILL.md\` tells
                      you how to invoke each.

Rules:
  1. For typical mentions/DMs, call reply once and stop. Don't inspect skills
     when a plain reply is enough — that's wasted turns.
  2. Use thread first only if you need conversation context to answer well.
  3. Use shell only when reply/thread cannot do the job.
  4. After a successful reply, produce a one-line final message and stop.
     Do not call more tools.
  5. Never reply to your own messages (data.user, data.sender, data.bot_id).
     The adapter already filters self-events but verify if in doubt.
  6. Be concise.`;

// Observational memory: conversation history + per-thread working memory +
// semantic recall, all backed by the same Upstash instance our control plane
// uses for sandbox/snapshot state. Keyed by event.threadId.
const memory = process.env.UPSTASH_REDIS_REST_URL
  ? new Memory({
      storage: new UpstashStore({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      }),
      vector: new UpstashVector({
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      }),
      options: {
        lastMessages: 10,                 // inject last 10 messages every turn
        semanticRecall: { topK: 3, messageRange: 2 },
        workingMemory: { enabled: true },
      },
    })
  : undefined;

const athena = new Agent({
  name: "athena",
  instructions,
  model: "openrouter/deepseek/deepseek-v3.2",
  tools: { reply, thread, shell },
  memory,
});

const r = await athena.generate(
  `Event envelope:\n${JSON.stringify(event, null, 2)}`,
  {
    maxSteps: 6,
    threadId: event.threadId,
    resourceId: "athena",                 // single agent identity for now
  },
);
console.log("[agent] done:", r.text.slice(0, 400));
