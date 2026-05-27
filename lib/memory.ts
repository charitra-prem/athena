// Vercel Blob <-> sandbox filesystem bridge for Athena's durable memory.
//
// Blob namespace: orgs/<orgId>/{org,projects/<channel>,users/<userId>}/...
// Sandbox path:   /vercel/sandbox/memory/{org,projects/<channel>,users/<userId>}/...
//
// hydrate() pulls every accessible blob for an event, composes a single
// CONTEXT.md aggregating each tier's facts.md plus a manifest of remaining
// files, and returns the batch ready for sb.writeFiles. dehydrate() scans
// the same sandbox tree for files newer than a touch-marker and PUTs each
// back to its blob key. Every blob op is gated by identity.canAccess.

import { list, put } from "@vercel/blob";
import type { Sandbox } from "@vercel/sandbox";
import { canAccess, type Identity } from "./identity.js";
import type { Envelope } from "./spawn.js";

export type MemoryFile = { path: string; content: string };

const SANDBOX_MEM_ROOT = "/vercel/sandbox/memory/";
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

function assertConfigured(): void {
  if (!BLOB_TOKEN) {
    throw new Error(
      "Vercel Blob not configured. Set BLOB_READ_WRITE_TOKEN on the function env. " +
        "Create a store via `vercel blob create athena-memory` or in the Vercel dashboard.",
    );
  }
}

// Slack resourceId is "slack:<team>:<channel>"; we keep only the channel
// suffix as the project key so blob URLs stay short and source-agnostic.
function projectKey(env: Envelope): string {
  return env.resourceId.split(":").pop() ?? env.resourceId;
}

function blobToSandbox(blobKey: string, orgId: string): string {
  // orgs/<orgId>/foo/bar -> memory/foo/bar  (writeFiles paths are relative to /vercel/sandbox/)
  return "memory/" + blobKey.slice(`orgs/${orgId}/`.length);
}

function sandboxToBlob(sandboxPath: string, orgId: string): string {
  // /vercel/sandbox/memory/foo/bar -> orgs/<orgId>/foo/bar
  return `orgs/${orgId}/` + sandboxPath.slice(SANDBOX_MEM_ROOT.length);
}

type BlobMeta = { pathname: string; url: string; size: number };

async function listPrefix(prefix: string): Promise<BlobMeta[]> {
  const r = await list({ prefix, token: BLOB_TOKEN });
  return r.blobs.map((b) => ({ pathname: b.pathname, url: b.url, size: b.size }));
}

export async function hydrate(
  env: Envelope,
  id: Identity,
): Promise<{ files: MemoryFile[] }> {
  assertConfigured();

  const channel = projectKey(env);
  const prefixes: string[] = [
    `orgs/${id.orgId}/org/`,
    `orgs/${id.orgId}/projects/${channel}/`,
  ];
  if (id.userId !== null) prefixes.push(`orgs/${id.orgId}/users/${id.userId}/`);

  const lists = await Promise.all(prefixes.map(listPrefix));
  const allBlobs = lists.flat().filter((b) => canAccess(b.pathname, id));

  const contents = await Promise.all(
    allBlobs.map(async (b) => ({
      blob: b,
      text: await fetch(b.url).then((r) => r.text()),
    })),
  );

  const byKey = new Map(contents.map((c) => [c.blob.pathname, c]));
  const factsKey = (tier: string) => `orgs/${id.orgId}/${tier}/facts.md`;
  const orgFacts = byKey.get(factsKey("org"))?.text;
  const projFacts = byKey.get(factsKey(`projects/${channel}`))?.text;
  const userFacts = id.userId ? byKey.get(factsKey(`users/${id.userId}`))?.text : undefined;

  // Files that already appear inline in CONTEXT.md don't repeat in the manifest.
  const inlineKeys = new Set<string>([
    factsKey("org"),
    factsKey(`projects/${channel}`),
    ...(id.userId ? [factsKey(`users/${id.userId}`)] : []),
  ]);

  const manifest = contents
    .filter((c) => !inlineKeys.has(c.blob.pathname))
    .map((c) => `- ${blobToSandbox(c.blob.pathname, id.orgId)}  [${c.blob.size}B]`)
    .join("\n");

  let context = `# Memory context\n\n`;
  context += `## Org (orgs/${id.orgId}/org)\n${orgFacts ?? "(no org facts yet)"}\n\n`;
  context += `## Project (channel ${channel})\n${projFacts ?? "(no project facts yet)"}\n\n`;
  if (id.userId !== null) {
    context += `## You (${id.userId})\n${userFacts ?? "(no personal facts yet)"}\n\n`;
  }
  context += `## Other memory files (read with the \`read\` tool when relevant)\n`;
  context += manifest.length > 0 ? manifest + "\n" : "(none)\n";

  const files: MemoryFile[] = [{ path: "memory/CONTEXT.md", content: context }];
  for (const c of contents) {
    files.push({ path: blobToSandbox(c.blob.pathname, id.orgId), content: c.text });
  }
  return { files };
}

export async function dehydrate(
  sb: Sandbox,
  env: Envelope,
  id: Identity,
  runStartMarker: string,
): Promise<{ uploaded: number }> {
  assertConfigured();
  void env; // reserved for future per-source policy hooks

  const r = await sb.runCommand({
    cmd: "bash",
    args: [
      "-c",
      `find /vercel/sandbox/memory/org /vercel/sandbox/memory/projects /vercel/sandbox/memory/users -type f -newer ${runStartMarker} 2>/dev/null || true`,
    ],
  });
  const paths = (await r.stdout()).trim().split("\n").filter(Boolean);
  if (paths.length === 0) return { uploaded: 0 };

  const results = await Promise.all(
    paths.map(async (path) => {
      const blobKey = sandboxToBlob(path, id.orgId);
      if (!canAccess(blobKey, id)) {
        console.warn(`[memory] dehydrate: canAccess denied for ${blobKey}, skipping`);
        return false;
      }
      const cat = await sb.runCommand({ cmd: "cat", args: [path] });
      const content = await cat.stdout();
      await put(blobKey, content, {
        access: "public",
        token: BLOB_TOKEN,
        allowOverwrite: true,
        addRandomSuffix: false,
      });
      return true;
    }),
  );
  return { uploaded: results.filter(Boolean).length };
}
