// Clerk webhook receiver. Verifies Svix signature, writes user-link KV
// mappings on user.created when unsafe_metadata.slack_user_id is present.
// ACK quickly — Svix retries on >2s responses.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Webhook } from "svix";
import { kv } from "../lib/kv.js";

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
  if (req.method !== "POST") return res.status(405).send("method not allowed");

  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) return res.status(500).json({ error: "CLERK_WEBHOOK_SECRET not set" });

  const raw = await readRawBody(req);
  const headers = {
    "svix-id": req.headers["svix-id"]?.toString() ?? "",
    "svix-timestamp": req.headers["svix-timestamp"]?.toString() ?? "",
    "svix-signature": req.headers["svix-signature"]?.toString() ?? "",
  };

  let evt: any;
  try {
    evt = new Webhook(secret).verify(raw, headers);
  } catch {
    return res.status(400).json({ error: "bad signature" });
  }

  const type = evt?.type as string | undefined;
  if (type !== "user.created" && type !== "session.created") {
    return res.status(200).json({ ignored: type ?? "unknown" });
  }

  // session.created has user_id; user.created has id. Both expose unsafe_metadata
  // on the user object (session events include the full user nested).
  const user = type === "user.created" ? evt.data : evt.data?.user;
  const clerkUserId: string | undefined = user?.id;
  const slackId: string | undefined = user?.unsafe_metadata?.slack_user_id;

  if (clerkUserId && typeof slackId === "string" && slackId.includes(":")) {
    await kv.set(`user-link:slack:${slackId}`, clerkUserId);
  }

  return res.status(200).json({ ok: true });
}
