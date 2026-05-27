// Runs INSIDE the Vercel Sandbox, ONCE per event. Receives a normalized
// envelope { source, type, data } in EVENT_PAYLOAD, decides, acts, exits.
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

type Envelope = {
  source: string;
  type: string;
  data: {
    message_id?: string | null;
    thread_id?: string | null;
    subject?: string | null;
    sender?: string | null;
    snippet?: string | null;
    channel?: string | null;
    user?: string | null;
    text?: string | null;
    team?: string | null;
    raw?: unknown;
  };
};

const event = JSON.parse(process.env.EVENT_PAYLOAD ?? "null") as Envelope | null;
if (!event) {
  console.error("no EVENT_PAYLOAD");
  process.exit(1);
}

const { source, type, data } = event;
console.log(`[evt] source=${source} type=${type} mid=${data.message_id ?? "?"} tid=${data.thread_id ?? "?"}`);

const isSlack = source.startsWith("slack-");
const isGmail = source.startsWith("gmail-") || source.startsWith("composio-") || source.startsWith("nango-google-mail");

if (isGmail) {
  const sender = (data.sender ?? "").toString();
  if (sender.toLowerCase().includes((process.env.AGENT_EMAIL ?? "").toLowerCase())) {
    console.log("[skip] self-gmail:", sender);
    process.exit(0);
  }
}
if (isSlack) {
  const botId = process.env.SLACK_BOT_USER_ID ?? "";
  if (botId && data.user === botId) {
    console.log("[skip] self-slack:", data.user);
    process.exit(0);
  }
}

const slackReply = createTool({
  id: "slack_reply_in_thread",
  description: "Post a reply in the same Slack thread as the incoming event.",
  inputSchema: z.object({ text: z.string().describe("The message body to send.") }),
  execute: async (input: any) => {
    console.log("[slack_reply] input keys:", Object.keys(input ?? {}), "raw=", JSON.stringify(input).slice(0, 300));
    // Mastra has shipped a few shapes here; tolerate them all.
    const text =
      input?.context?.text ??
      input?.input?.text ??
      input?.text ??
      "";
    console.log("[slack_reply] posting to", data.channel, "thread", data.thread_id, "text=", text.slice(0, 80));
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort("timeout-10s"), 10_000);
    try {
      const r = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: data.channel,
          thread_ts: data.thread_id,
          text,
        }),
        signal: ctrl.signal,
      });
      console.log("[slack_reply] http status=" + r.status);
      const bodyText = await r.text();
      console.log("[slack_reply] body=" + bodyText.slice(0, 300));
      const j = JSON.parse(bodyText) as { ok: boolean; ts?: string; channel?: string; error?: string };
      if (!j.ok) return { error: j.error, ok: false };
      return { ts: j.ts, channel: j.channel, ok: true };
    } catch (e: any) {
      console.log("[slack_reply] error:", e?.message ?? e);
      return { error: e?.message ?? String(e), ok: false };
    } finally {
      clearTimeout(to);
    }
  },
});

let tools: Record<string, any> = {};
if (isSlack) {
  tools = { slack_reply_in_thread: slackReply };
}
if (isGmail) {
  console.log("[tools] loading composio gmail...");
  const { Composio } = await import("@composio/core");
  const { VercelProvider } = await import("@composio/vercel");
  const composio = new Composio({
    apiKey: process.env.COMPOSIO_API_KEY!,
    provider: new VercelProvider(),
  });
  tools = await composio.tools.get(process.env.AGENT_USER_ID!, { toolkits: ["GMAIL"] });
  console.log("[tools] gmail loaded");
}

const instructions = `You are Athena. You wake from external events and act once per wake.

Event source: ${source}
Event type: ${type}

${isGmail ? `GMAIL RULES:
- SAFETY GATE: only reply if subject contains "[athena]" (case-insensitive). Otherwise no tool calls.
- When the gate passes: reply in-thread via GMAIL_REPLY_TO_THREAD.
- You are ${process.env.AGENT_EMAIL}.` : ""}

${isSlack ? `SLACK RULES:
- For app_mention events: reply in-thread via slack_reply_in_thread. Always reply — the user explicitly addressed you.
- For plain message.im (direct messages): reply via slack_reply_in_thread.
- Be concise (1–2 sentences unless asked for detail).` : ""}

Decide based on the event, take at most one action, then stop.`;

console.log("[agent] generating...");
const athena = new Agent({
  name: "athena",
  instructions,
  model: "openrouter/deepseek/deepseek-v3.2",
  tools,
});

const r = await athena.generate(
  `Incoming event:\n${JSON.stringify(event, null, 2)}\n\nApply the rules for this source and decide.`,
);
console.log("[agent] done:", r.text.slice(0, 400));
