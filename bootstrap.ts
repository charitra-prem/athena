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

// ── Coding-agent toolchain ─────────────────────────────────────────────
// dnf-installable utilities + static binaries (rg/fd/gh) into /usr/local/bin.
// Versions are pinned; bump as needed.
const RG_VERSION = "14.1.1";
const FD_VERSION = "10.2.0";
const GH_VERSION = "2.66.1";

const toolchainScript = `set -euo pipefail
sudo dnf install -y --setopt=install_weak_deps=False --quiet jq tree make

cd /tmp
echo "[bootstrap] downloading ripgrep ${RG_VERSION}"
curl -sSLf "https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz" | tar -xz
sudo install -m 0755 "ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl/rg" /usr/local/bin/rg

echo "[bootstrap] downloading fd ${FD_VERSION}"
curl -sSLf "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/fd-v${FD_VERSION}-x86_64-unknown-linux-musl.tar.gz" | tar -xz
sudo install -m 0755 "fd-v${FD_VERSION}-x86_64-unknown-linux-musl/fd" /usr/local/bin/fd

echo "[bootstrap] downloading gh ${GH_VERSION}"
curl -sSLf "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" | tar -xz
sudo install -m 0755 "gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh

rm -rf /tmp/ripgrep-* /tmp/fd-v* /tmp/gh_*

echo "[bootstrap] verifying:"
rg --version | head -1
fd --version
gh --version | head -1
jq --version

mkdir -p /vercel/sandbox/work
`;

console.log("installing coding-agent toolchain…");
const tools = await sb.runCommand({
  cmd: "bash",
  args: ["-c", toolchainScript],
  stdout: process.stdout,
  stderr: process.stderr,
});
if (tools.exitCode !== 0) throw new Error(`toolchain install failed: exit ${tools.exitCode}`);

console.log("installing npm deps…");
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
