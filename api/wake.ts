// Broker contract: accepts a pre-normalized envelope and spawns a sandbox.
// Vendor-specific shapes belong in /api/sources/{vendor}.ts — NOT here.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { spawnSandbox, type Envelope } from "../lib/spawn.js";

function isEnvelope(b: any): b is Envelope {
  return (
    b &&
    typeof b.source === "string" &&
    typeof b.type === "string" &&
    typeof b.threadId === "string" &&
    typeof b.resourceId === "string" &&
    typeof b.orgId === "string" &&
    b.data && typeof b.data === "object"
  );
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") return res.status(405).send("method not allowed");

    const secret = process.env.INGEST_SECRET;
    if (secret && req.headers["x-ingest-secret"] !== secret) {
      return res.status(403).send("forbidden");
    }

    if (!isEnvelope(req.body)) {
      return res.status(400).json({
        error: "expected envelope { source, type, threadId, resourceId, orgId, data }",
        hint: "vendor-shaped payloads should POST to /api/sources/{vendor}",
        got: req.body,
      });
    }

    const result = await spawnSandbox(req.body);
    res.status(200).json({
      ...result,
      source: req.body.source,
      type: req.body.type,
      threadId: req.body.threadId,
      resourceId: req.body.resourceId,
      orgId: req.body.orgId,
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e), stack: e?.stack?.split("\n").slice(0, 6) });
  }
}
