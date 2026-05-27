// Called by the sign-in page after Clerk auth completes. Verifies the
// Clerk session JWT in the Authorization header and writes the user-link
// KV mapping so future events from this Slack user resolve to this Clerk
// user. Idempotent: relinking just overwrites.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyToken } from "@clerk/backend";
import { kv } from "../lib/kv.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("method not allowed");

  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return res.status(500).send("CLERK_SECRET_KEY not set");

  const authz = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!authz) return res.status(401).send("missing bearer token");

  let payload: { sub?: string };
  try {
    payload = await verifyToken(authz, { secretKey });
  } catch (e: any) {
    return res.status(401).send(`invalid token: ${e?.message ?? "unknown"}`);
  }
  const userId = payload.sub;
  if (!userId) return res.status(401).send("token has no subject");

  const slack: string = (req.body as any)?.slack ?? "";
  if (!slack || !slack.includes(":")) {
    return res.status(400).send("missing or malformed slack id");
  }

  await kv.set(`user-link:slack:${slack}`, userId);
  return res.status(200).json({ ok: true, slack, userId });
}
