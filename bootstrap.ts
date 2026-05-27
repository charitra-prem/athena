// Run ONCE locally (or whenever agent.package.json or skills/ change).
// Spins up a sandbox, npm-installs deps, copies skills/, snapshots,
// prints the snapshotId.
import { Sandbox } from "@vercel/sandbox";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import ms from "ms";
import { cleanFetch } from "./lib/clean-fetch.js";

function walk(absDir: string, relDir: string): Array<{ path: string; content: string }> {
  const out: Array<{ path: string; content: string }> = [];
  for (const name of readdirSync(absDir)) {
    const abs = join(absDir, name);
    const rel = posix.join(relDir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, rel));
    else out.push({ path: rel, content: readFileSync(abs, "utf8") });
  }
  return out;
}

const pkg = readFileSync(new URL("./agent.package.json", import.meta.url), "utf8");
const skillFiles = walk(new URL("./skills", import.meta.url).pathname, "skills");

const sb = await Sandbox.create({
  teamId: process.env.VERCEL_TEAM_ID!,
  projectId: process.env.VERCEL_PROJECT_ID!,
  token: process.env.VERCEL_TOKEN!,
  fetch: cleanFetch,
  runtime: "node22",
  resources: { vcpus: 2 },
  timeout: ms("10m"),
});

console.log("bootstrap sandbox:", sb.sandboxId);

await sb.writeFiles([
  { path: "package.json", content: pkg },
  ...skillFiles,
]);
console.log(`copied ${skillFiles.length} skill file(s)`);

console.log("installing deps…");
const install = await sb.runCommand({
  cmd: "npm",
  args: ["install", "--no-audit", "--no-fund", "--loglevel=error"],
  stdout: process.stdout,
  stderr: process.stderr,
});
if (install.exitCode !== 0) throw new Error(`install failed: exit ${install.exitCode}`);

console.log("snapshotting (stops the sandbox)…");
const snap = await sb.snapshot();
console.log("\nSnapshot id:", snap.snapshotId);
console.log("\nAppend to .env:\nSANDBOX_SNAPSHOT_ID=" + snap.snapshotId);
