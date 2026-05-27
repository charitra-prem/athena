// Slack slash-command receiver. Currently handles one command: /athena-login.
// Returns an ephemeral message containing a sign-in URL with the user's
// slack identity baked in as a query param (consumed by api/sign-in.tsx).
//
// Slash commands POST application/x-www-form-urlencoded, not JSON.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { createHmac, timingSafeEqual } from "node:crypto";

function verifySlack(req: VercelRequest, rawBody: string): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return true; // dev-mode: skip if not set
  const ts = req.headers["x-slack-request-timestamp"]?.toString() ?? "";
  const sig = req.headers["x-slack-signature"]?.toString() ?? "";
  if (!ts || !sig) return false;
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

function parseForm(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const idx = pair.indexOf("=");
    const k = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, " "));
    const v = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, " "));
    out[k] = v;
  }
  return out;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("method not allowed");

  const raw = await readRawBody(req);
  if (!verifySlack(req, raw)) return res.status(403).send("bad signature");

  const body = parseForm(raw);
  const cmd = body.command ?? "";
  const teamId = body.team_id ?? "";
  const userId = body.user_id ?? "";

  if (cmd !== "/athena-login") {
    return res.status(200).json({
      response_type: "ephemeral",
      text: `unknown command: ${cmd}`,
    });
  }

  // Build the public URL from the request host so the link works on previews
  // and prod without a separate env var.
  const proto = req.headers["x-forwarded-proto"]?.toString() ?? "https";
  const host = req.headers.host ?? "";
  const signInUrl = `${proto}://${host}/api/sign-in?slack=${encodeURIComponent(`${teamId}:${userId}`)}`;

  return res.status(200).json({
    response_type: "ephemeral",
    text: `Link your Slack identity to Athena: <${signInUrl}|Sign in here>. After signing in, your personal memory tier becomes available in conversations with the bot.`,
  });
}
