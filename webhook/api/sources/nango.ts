// Nango adapter. Translates Nango's sync-webhook shape into our envelope.
// Nango webhooks are notifications — they don't carry records. We call
// Nango back to fetch the actual data, then emit one envelope per record.
//
// To swap Nango out: delete this file and write /api/sources/{whatever}.ts
// that ends with the same spawnSandbox({source, type, data}) call. Nothing
// downstream of /lib/spawn.ts knows or cares which vendor was the source.
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { spawnSandbox } from "../../lib/spawn.js";

type NangoSyncWebhook = {
  from: "nango";
  type: "sync";
  connectionId: string;
  providerConfigKey: string;
  syncName: string;
  model: string;
  responseResults: { added: number; updated: number; deleted: number };
  syncType: "INCREMENTAL" | "FULL";
  modifiedAfter?: string;
  queriedAt?: string;
};

async function fetchNangoRecords(args: {
  connectionId: string;
  providerConfigKey: string;
  model: string;
  modifiedAfter?: string;
}) {
  const url = new URL("https://api.nango.dev/records");
  url.searchParams.set("model", args.model);
  if (args.modifiedAfter) url.searchParams.set("modified_after", args.modifiedAfter);

  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${process.env.NANGO_SECRET_KEY!}`,
      "Connection-Id": args.connectionId,
      "Provider-Config-Key": args.providerConfigKey,
    },
  });
  if (!r.ok) throw new Error(`nango records ${r.status}: ${await r.text()}`);
  return (await r.json()) as { records: any[]; next_cursor?: string | null };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== "POST") return res.status(405).send("method not allowed");

    // Auth: Nango signs webhooks with a secret you configure on their side.
    // We compare against NANGO_WEBHOOK_SECRET that we set when wiring up.
    const secret = process.env.NANGO_WEBHOOK_SECRET;
    if (secret && req.headers["x-nango-signature"] !== secret) {
      return res.status(403).send("forbidden");
    }

    const body = req.body as NangoSyncWebhook;
    if (body?.from !== "nango" || body?.type !== "sync") {
      return res.status(400).json({ error: "not a nango sync webhook", got: body });
    }

    // Only act on adds for now (updates/deletes can be wired later).
    if ((body.responseResults?.added ?? 0) === 0) {
      return res.status(200).json({ skipped: "no adds", body });
    }

    const { records } = await fetchNangoRecords({
      connectionId: body.connectionId,
      providerConfigKey: body.providerConfigKey,
      model: body.model,
      modifiedAfter: body.modifiedAfter,
    });

    // For the prebuilt google-mail "emails" sync, fields look like:
    //   { id, threadId, subject, from, to, date, snippet, body, ... }
    const adds = records.filter((r) => r._nango_metadata?.last_action === "ADDED");

    const sandboxes: Array<{ sandboxId: string; bootMs: number; mid: string }> = [];
    for (const rec of adds) {
      const envelope = {
        source: `nango-${body.providerConfigKey}`,
        type: body.model === "GmailEmail" ? "new-email" : body.model.toLowerCase(),
        data: {
          message_id: rec.id ?? null,
          thread_id: rec.threadId ?? null,
          subject: rec.subject ?? null,
          sender: rec.from ?? null,
          snippet: rec.snippet ?? rec.body?.slice?.(0, 200) ?? null,
          raw: rec,
        },
      };
      const { sandboxId, bootMs } = await spawnSandbox(envelope);
      sandboxes.push({ sandboxId, bootMs, mid: rec.id });
    }

    res.status(200).json({ spawned: sandboxes.length, sandboxes });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? String(e), stack: e?.stack?.split("\n").slice(0, 6) });
  }
}
