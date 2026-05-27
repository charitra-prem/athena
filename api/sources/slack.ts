// Slack Events API adapter. Slack POSTs directly to this URL — no broker, no
// Pub/Sub. We verify the signature, ack within 3s, and translate into our
// envelope contract.
//
// Slack sends three relevant shapes:
//   1. url_verification    — one-time challenge during setup. Echo back.
//   2. event_callback      — actual events (app_mention, message, etc.).
//   3. interactive_message — buttons/modals. Ignored for now.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { spawnSandbox } from "../../lib/spawn.js";
import { kv } from "../../lib/kv.js";

function verifySlack(req: VercelRequest, rawBody: string): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // dev-mode: skip if not set
  const ts = req.headers["x-slack-request-timestamp"]?.toString() ?? "";
  const sig = req.headers["x-slack-signature"]?.toString() ?? "";
  if (!ts || !sig) return false;
  // reject if older than 5 min (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const base = `v0:${ts}:${rawBody}`;
  const expected = "v0=" + createHmac("sha256", signingSecret).update(base).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  } catch {
    return false;
  }
}

export const config = { api: { bodyParser: false } };

async function readRawBody(req: VercelRequest): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => (buf += c));
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") return res.status(405).send("method not allowed");

    const raw = await readRawBody(req);
    if (!verifySlack(req, raw)) return res.status(403).send("bad signature");

    const body = JSON.parse(raw);

    // 1. URL verification handshake (during Event Subscriptions setup)
    if (body.type === "url_verification") {
      return res.status(200).json({ challenge: body.challenge });
    }

    // 2. Event callback. ACK FIRST (Slack expects <3s), then spawn async.
    if (body.type === "event_callback") {
      const ev = body.event ?? {};

      // Ignore the bot's own messages (avoid loops)
      const botId = process.env.SLACK_BOT_USER_ID;
      if (botId && (ev.user === botId || ev.bot_id)) {
        res.status(200).json({ skipped: "self-message" });
        return;
      }

      // Only care about messages and mentions for now
      const interesting = ev.type === "app_mention" || ev.type === "message";
      if (!interesting) {
        res.status(200).json({ skipped: `event type ${ev.type}` });
        return;
      }

      // Ignore message_changed / message_deleted / channel_join etc. — those
      // arrive as ev.type "message" but with a subtype.
      if (ev.type === "message" && ev.subtype) {
        res.status(200).json({ skipped: `message subtype ${ev.subtype}` });
        return;
      }

      // Canonical thread id — survives across messages in the same Slack thread,
      // and is what KV / snapshots / Mastra Memory are keyed off.
      const threadRoot = ev.thread_ts ?? ev.ts;
      const threadId = `slack:${body.team_id}:${ev.channel}:${threadRoot}`;
      // Project = the Slack channel/group. Shared across all threads in it.
      const resourceId = `slack:${body.team_id}:${ev.channel}`;

      // Follow-ups: a plain `message` event in a channel/group only triggers
      // Athena if (a) it's a thread reply (thread_ts set) AND (b) Athena has
      // state for that thread (i.e. we engaged in it before).
      // DMs (message.im, where channel starts with "D") always pass through.
      if (ev.type === "message") {
        const isDm = (ev.channel ?? "").startsWith("D");
        if (!isDm) {
          if (!ev.thread_ts) {
            res.status(200).json({ skipped: "channel top-level message" });
            return;
          }
          // Cheap KV lookup — does Athena know this thread?
          const state = await kv.get(`sandbox:${threadId}`).catch(() => null);
          if (!state) {
            res.status(200).json({ skipped: "thread not engaged" });
            return;
          }
        }
      }

      // ACK Slack immediately — fire-and-forget the spawn
      res.status(200).json({ ok: true });

      const envelope = {
        source: "slack-events",
        type: ev.type, // "app_mention" | "message"
        threadId,
        resourceId,
        data: {
          message_id: ev.client_msg_id ?? ev.ts ?? null,
          thread_id: threadRoot,
          channel: ev.channel ?? null,
          user: ev.user ?? null,
          text: ev.text ?? null,
          team: body.team_id ?? null,
          raw: body,
        },
      };

      // Vercel kills the process after res.end(); use waitUntil to keep the
      // spawn alive past the response.
      waitUntil(
        spawnSandbox(envelope)
          .then((s) =>
            console.log(
              `[slack] sbx=${s.sandboxId} reused=${s.reused} dirty=${s.dirty} total=${s.totalMs}ms`,
            ),
          )
          .catch((e) => console.error("[slack] spawn failed:", e?.message ?? e)),
      );
      return;
    }

    return res.status(200).json({ ignored: body.type });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e) });
  }
}
