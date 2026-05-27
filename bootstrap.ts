// Run ONCE locally (or whenever agent.package.json changes).
// Spins up a sandbox, npm-installs deps, snapshots, prints the snapshotId.
import { Sandbox } from "@vercel/sandbox";
import { readFileSync } from "node:fs";
import ms from "ms";
import { cleanFetch } from "./lib/clean-fetch.js";

const pkg = readFileSync(new URL("./agent.package.json", import.meta.url), "utf8");

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
await sb.writeFiles([{ path: "package.json", content: pkg }]);

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
