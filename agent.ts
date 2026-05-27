// Runs INSIDE the Vercel Sandbox, ONCE per event. Reads a normalized envelope
// { source, type, threadId, data } from EVENT_PAYLOAD, acts, exits.
//
// Slack-events path: streams the agent's response live via Slack's
// chat.startStream / chat.appendStream / chat.stopStream API. The agent's
// text IS the delivery — no reply tool needed.
// Non-Slack sources: agent text is generated, logged, and (today) discarded.
// When a new source adapter lands, wire its delivery here.
//
// Memory has two scopes:
//   - threadId   = one conversation (e.g. one Slack thread)
//   - resourceId = the project around it (e.g. the channel) — shared by every
//                  thread in the same place. workingMemory + semanticRecall
//                  are scoped to the resource, so what Athena learns in one
//                  thread is available in every thread of the same channel.
//
// Tools (coding-agent suite):
//   bash   — full shell escape hatch (pipes, sudo, redirects).
//   read   — read a file with line numbers.
//   write  — create or overwrite a file (parent dirs auto-created).
//   edit   — exact string replacement (errors on ambiguity).
//   grep   — content search via ripgrep.
//   glob   — file discovery via fd.
// Skills under $SKILLS_DIR expose higher-level helpers (slack, etc.).
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { Memory } from "@mastra/memory";
import { UpstashStore, UpstashVector } from "@mastra/upstash";
import { exec as execCb, execFile as execFileCb } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const exec = promisify(execCb);
const execFile = promisify(execFileCb);

// ── OpenRouter embedder (AI-SDK-compatible) ──────────────────────────────
const openrouterEmbedder = {
  specificationVersion: "v1" as const,
  provider: "openrouter",
  modelId: "openai/text-embedding-3-small",
  maxEmbeddingsPerCall: 64,
  supportsParallelCalls: true,
  async doEmbed({ values }: { values: string[] }) {
    const r = await fetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "openai/text-embedding-3-small", input: values }),
    });
    const j = (await r.json()) as any;
    if (j.error) throw new Error(`openrouter embed: ${j.error.message ?? JSON.stringify(j.error)}`);
    return {
      embeddings: j.data.map((d: any) => d.embedding as number[]),
      usage: { tokens: j.usage?.total_tokens ?? 0 },
    };
  },
};

// ── Envelope + slack helpers ─────────────────────────────────────────────
type Envelope = {
  source: string;
  type: string;
  threadId: string;          // "slack:<team>:<channel>:<thread_root>"
  resourceId: string;        // project scope, e.g. "slack:<team>:<channel>"
  data: {
    channel?: string | null;
    thread_id?: string | null;
    user?: string | null;
    text?: string | null;
    team?: string | null;
    [k: string]: unknown;
  };
};

const event = JSON.parse(process.env.EVENT_PAYLOAD ?? "null") as Envelope | null;
if (!event) {
  console.error("no EVENT_PAYLOAD");
  process.exit(1);
}
console.log(`[evt] source=${event.source} type=${event.type}`);

async function slackApi(method: string, params: Record<string, any>, get = false) {
  const url = `https://slack.com/api/${method}` + (get ? `?${new URLSearchParams(params)}` : "");
  const r = await fetch(url, {
    method: get ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    ...(get ? {} : { body: JSON.stringify(params) }),
  });
  return (await r.json()) as { ok: boolean; error?: string; [k: string]: any };
}

const isSlack = event.source.startsWith("slack-");

// ── Tool ─────────────────────────────────────────────────────────────────
// One tool: bash. Replies are streamed (Slack) or returned as text (others).
// Anything else — reading/writing files, running tests, installing packages,
// invoking skills, hitting APIs via curl — goes through bash.
//
// State between calls: the bash tool spawns a new shell per invocation, so
// `cd`, `export`, etc. do NOT persist. Use absolute paths and pass `cwd`.
const BASH_WORK_DIR = "/vercel/sandbox/work";
const BASH_DEFAULT_TIMEOUT_MS = 2 * 60_000;       // 2 min
const BASH_MAX_TIMEOUT_MS = 9 * 60_000;           // sandbox dies at 10 min (SANDBOX_TIMEOUT_MS)

// Paths in tool inputs are resolved relative to the work dir if not absolute,
// so the agent doesn't have to keep typing /vercel/sandbox/work everywhere.
function resolvePath(p?: string): string {
  if (!p) return BASH_WORK_DIR;
  return isAbsolute(p) ? p : resolve(BASH_WORK_DIR, p);
}

const bash = createTool({
  id: "bash",
  description:
    "Run a bash command. Full shell: pipes, redirects, subshells, heredocs, " +
    "globs. Standard tools available (cat, ls, find, grep, sed, awk, jq, " +
    "tree, make, git, gh, node, npm, python3, curl, rg, fd, …). `sudo` works " +
    "without a password — install more packages with `sudo dnf install -y <pkg>`. " +
    `Default cwd is ${BASH_WORK_DIR} (auto-created); pass \`cwd\` to override. ` +
    `Default timeout ${BASH_DEFAULT_TIMEOUT_MS / 1000}s (max ${BASH_MAX_TIMEOUT_MS / 1000}s). ` +
    "A fresh shell is spawned per call — `cd` and `export` don't persist; " +
    "use absolute paths or pass `cwd`. Skills under $SKILLS_DIR provide " +
    "higher-level helpers; `cat $SKILLS_DIR/<name>/SKILL.md` for each. " +
    "Returns { stdout, stderr, exit }; output capped at 10MB.",
  inputSchema: z.object({
    cmd: z.string().describe("The bash command to run."),
    cwd: z.string().optional().describe(`Working directory. Default ${BASH_WORK_DIR}.`),
    timeout: z
      .number()
      .int()
      .min(1_000)
      .max(BASH_MAX_TIMEOUT_MS)
      .optional()
      .describe(`Override timeout in ms (default ${BASH_DEFAULT_TIMEOUT_MS}).`),
  }),
  execute: async (input: any) => {
    const ctx = input?.context ?? input ?? {};
    const cmd: string = ctx.cmd ?? "";
    const cwd: string = ctx.cwd ?? BASH_WORK_DIR;
    const timeout: number = ctx.timeout ?? BASH_DEFAULT_TIMEOUT_MS;
    console.log(`[bash] (${cwd}) $ ${cmd}`);
    try {
      // Ensure cwd exists. Cheap; mkdir -p is a no-op when present.
      await exec(`mkdir -p ${JSON.stringify(cwd)}`, { shell: "/bin/bash" });
      const { stdout, stderr } = await exec(cmd, {
        cwd,
        env: process.env,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        shell: "/bin/bash",
      });
      return { stdout, stderr, exit: 0 };
    } catch (e: any) {
      const killed = e?.killed === true || e?.signal === "SIGTERM";
      return {
        stdout: e?.stdout ?? "",
        stderr: (e?.stderr ?? "") + (killed ? `\n[bash] killed after ${timeout}ms` : ""),
        exit: typeof e?.code === "number" ? e.code : 1,
      };
    }
  },
});

// ── File tools ───────────────────────────────────────────────────────────
const read = createTool({
  id: "read",
  description:
    "Read a file from disk with 1-indexed line numbers (like `cat -n`). " +
    "Relative paths are resolved against /vercel/sandbox/work. For large " +
    "files, pass `offset` and `limit` to page through.",
  inputSchema: z.object({
    path: z.string(),
    offset: z.number().int().min(1).optional().describe("Starting line (1-indexed). Default 1."),
    limit: z.number().int().min(1).max(5000).optional().describe("Max lines. Default 2000."),
  }),
  execute: async (input: any) => {
    const ctx = input?.context ?? input ?? {};
    const path = resolvePath(ctx.path);
    const offset: number = ctx.offset ?? 1;
    const limit: number = ctx.limit ?? 2000;
    try {
      const content = await readFile(path, "utf8");
      const lines = content.split("\n");
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const width = String(offset + slice.length - 1).length;
      const numbered = slice
        .map((l, i) => `${String(offset + i).padStart(width)}\t${l}`)
        .join("\n");
      return {
        ok: true,
        path,
        total_lines: lines.length,
        showing: `${offset}-${offset + slice.length - 1}`,
        content: numbered,
      };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
});

const write = createTool({
  id: "write",
  description:
    "Write content to a file, overwriting if it exists. Parent directories " +
    "are created automatically. Relative paths resolve against the work dir.",
  inputSchema: z.object({
    path: z.string(),
    content: z.string(),
  }),
  execute: async (input: any) => {
    const ctx = input?.context ?? input ?? {};
    const path = resolvePath(ctx.path);
    const content: string = ctx.content ?? "";
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      return { ok: true, path, bytes: Buffer.byteLength(content, "utf8") };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
});

const edit = createTool({
  id: "edit",
  description:
    "Replace exact text in a file. `old_string` MUST match exactly. By " +
    "default it must appear exactly ONCE in the file; if it appears multiple " +
    "times the call errors so you can add surrounding context to make it " +
    "unique. Set `replace_all: true` to replace every occurrence (use for " +
    "renames). Always re-read the file after editing to confirm.",
  inputSchema: z.object({
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  }),
  execute: async (input: any) => {
    const ctx = input?.context ?? input ?? {};
    const path = resolvePath(ctx.path);
    const oldStr: string = ctx.old_string ?? "";
    const newStr: string = ctx.new_string ?? "";
    const all = ctx.replace_all === true;
    if (oldStr === "") return { ok: false, error: "old_string must be non-empty" };
    try {
      const content = await readFile(path, "utf8");
      const occurrences = content.split(oldStr).length - 1;
      if (occurrences === 0) return { ok: false, error: "old_string not found" };
      if (!all && occurrences > 1) {
        return {
          ok: false,
          error: `old_string appears ${occurrences} times; add context to make it unique, or pass replace_all`,
        };
      }
      const next = all ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
      await writeFile(path, next, "utf8");
      return { ok: true, path, replacements: all ? occurrences : 1 };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },
});

const grep = createTool({
  id: "grep",
  description:
    "Search file contents with ripgrep. Returns matches with file:line:text. " +
    "Respects .gitignore. `pattern` is a regex. Path defaults to the work dir.",
  inputSchema: z.object({
    pattern: z.string().describe("Regex pattern."),
    path: z.string().optional(),
    glob: z.string().optional().describe("Filter files by glob (e.g. '*.ts')."),
    case_insensitive: z.boolean().optional(),
    context_lines: z.number().int().min(0).max(10).optional(),
    max_count: z.number().int().min(1).max(1000).optional().describe("Default 200."),
  }),
  execute: async (input: any) => {
    const ctx = input?.context ?? input ?? {};
    const args: string[] = ["--line-number", "--with-filename", "--color=never"];
    if (ctx.case_insensitive) args.push("-i");
    if (typeof ctx.context_lines === "number" && ctx.context_lines > 0) {
      args.push(`-C${ctx.context_lines}`);
    }
    args.push(`-m${ctx.max_count ?? 200}`);
    if (ctx.glob) args.push("-g", ctx.glob);
    args.push("--", ctx.pattern, resolvePath(ctx.path));
    try {
      const { stdout } = await execFile("rg", args, {
        env: process.env,
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { ok: true, matches: stdout };
    } catch (e: any) {
      // rg exit 1 == no matches (not an error)
      if (e?.code === 1 && !e?.stderr) return { ok: true, matches: "" };
      return { ok: false, error: e?.stderr ?? e?.message ?? String(e), exit: e?.code };
    }
  },
});

const glob = createTool({
  id: "glob",
  description:
    "Find files matching a glob pattern with fd. Returns a list of paths. " +
    "Respects .gitignore by default. Path defaults to the work dir.",
  inputSchema: z.object({
    pattern: z.string().describe("Glob (e.g. '*.ts', '**/*.tsx')."),
    path: z.string().optional(),
    include_hidden: z.boolean().optional(),
    type: z.enum(["file", "dir"]).optional(),
    max_results: z.number().int().min(1).max(2000).optional().describe("Default 500."),
  }),
  execute: async (input: any) => {
    const ctx = input?.context ?? input ?? {};
    const args: string[] = ["--glob", ctx.pattern];
    if (ctx.include_hidden) args.push("-H");
    if (ctx.type === "file") args.push("-tf");
    else if (ctx.type === "dir") args.push("-td");
    args.push("--max-results", String(ctx.max_results ?? 500));
    args.push(".");
    try {
      const { stdout } = await execFile("fd", args, {
        cwd: resolvePath(ctx.path),
        env: process.env,
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const paths = stdout.split("\n").filter(Boolean);
      return { ok: true, count: paths.length, paths };
    } catch (e: any) {
      return { ok: false, error: e?.stderr ?? e?.message ?? String(e), exit: e?.code };
    }
  },
});

// ── Memory ────────────────────────────────────────────────────────────────
const memory = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  ? new Memory({
      storage: new UpstashStore({
        id: "athena-store",
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      }),
      vector: new UpstashVector({
        id: "athena-vector",
        url: process.env.UPSTASH_REDIS_REST_URL!,
        token: process.env.UPSTASH_REDIS_REST_TOKEN!,
      }),
      embedder: openrouterEmbedder as any,
      options: {
        lastMessages: 10,                                          // thread-scoped (always)
        semanticRecall: { topK: 3, messageRange: 2, scope: "resource" },
        workingMemory: { enabled: true, scope: "resource" },
      },
    })
  : undefined;

// ── Instructions (delivery-aware) ────────────────────────────────────────
const memoryContext = (() => {
  try {
    return readFileSync("/vercel/sandbox/memory/CONTEXT.md", "utf8");
  } catch {
    return "";
  }
})();

const baseInstructions = `You are Athena. You wake from one external event, act once, then exit.

The event envelope is in your prompt: { source, type, threadId, resourceId, data }.

DELIVERY: your response text is automatically STREAMED to the user as you
generate it. Just produce the answer as your text — do NOT call any tool
to deliver it.

Tools (prefer the structured ones over raw bash where they apply):
  • read(path, offset?, limit?)         — line-numbered file view.
  • write(path, content)                — create/overwrite (parent dirs auto).
  • edit(path, old_string, new_string, replace_all?)
                                        — exact string replacement; errors
                                          unless old_string is unique (or
                                          replace_all=true).
  • grep(pattern, path?, glob?, …)      — ripgrep over file contents.
  • glob(pattern, path?, …)             — fd over file paths.
  • bash(cmd, cwd?, timeout?)           — full shell escape hatch (pipes,
                                          redirects, sudo, dnf, git, gh,
                                          curl, npm, tests, builds). \`cd\`
                                          and \`export\` do NOT persist
                                          between calls — pass \`cwd\`.

Working as a coding agent:
  • Default workdir is /vercel/sandbox/work. Paths in read/write/edit/grep/
    glob are resolved against it if not absolute. Clone, edit, build, test
    inside it.
  • Inspect before editing. Use read/grep/glob to understand the code first.
  • Re-read the file after edit() to confirm. If edit complains old_string
    isn't unique, widen the snippet — don't fall back to sed.
  • Run tests/lints before claiming a change works. Surface non-zero exits.
  • Need git/gh? Use bash. The \`gh\` CLI needs auth (\`gh auth login --with-token\`)
    if you want to push or open PRs.
  • Long-running things (npm install, builds, test suites) can take minutes.
    bash defaults to 2 min; pass \`timeout\` up to 540000 (9 min) if needed.

Slack / channel-side actions go through skills:
  • \`cat $SKILLS_DIR/<name>/SKILL.md\` for usage of each skill (slack, etc.).

Rules:
  1. For typical questions, just generate the answer text. Don't reach for
     tools unless you actually need to inspect or change something.
  2. Fetch thread context only if you can't answer well without it.
  3. Never respond to your own messages (data.user / data.bot_id). The
     adapter filters self-events but verify if in doubt.
  4. Be concise. Markdown is rendered.`;

const instructions = memoryContext
  ? `${memoryContext}\n\n---\n\n${baseInstructions}`
  : baseInstructions;

const tools = { bash, read, write, edit, grep, glob };

const athena = new Agent({
  name: "athena",
  instructions,
  model: "openrouter/deepseek/deepseek-v3.2",
  tools,
  memory,
});

const prompt = `Event envelope:\n${JSON.stringify(event, null, 2)}`;

// ── Slack streaming path ─────────────────────────────────────────────────
if (isSlack) {
  // 1. Open a live stream message in the thread.
  const start = await slackApi("chat.startStream", {
    channel: event.data.channel,
    thread_ts: event.data.thread_id,
    recipient_team_id: event.data.team,
    recipient_user_id: event.data.user,
  });
  if (!start.ok) {
    console.error(`[stream] startStream failed: ${start.error}`);
    process.exit(1);
  }
  const messageTs = start.ts as string;
  console.log(`[stream] start ts=${messageTs}`);

  // 2. Buffer agent deltas; flush every 80 chars OR 250ms.
  let buf = "";
  let lastFlush = Date.now();
  const flush = async () => {
    if (!buf) return;
    const chunk = buf;
    buf = "";
    const r = await slackApi("chat.appendStream", {
      channel: event.data.channel,
      ts: messageTs,
      markdown_text: chunk,
    });
    if (!r.ok) console.error(`[stream] append failed: ${r.error}`);
    lastFlush = Date.now();
  };

  // 3. Stream from the agent.
  const result = await athena.stream(prompt, {
    maxSteps: 6,
    threadId: event.threadId,
    resourceId: event.resourceId,
  } as any);

  for await (const delta of (result as any).textStream as AsyncIterable<string>) {
    buf += delta;
    if (buf.length >= 80 || Date.now() - lastFlush > 250) await flush();
  }
  await flush();

  // 4. Finalize.
  const stop = await slackApi("chat.stopStream", {
    channel: event.data.channel,
    ts: messageTs,
  });
  console.log(`[stream] stop ok=${stop.ok} err=${stop.error ?? "-"}`);
} else {
  // ── Non-streaming path (non-Slack sources) ────────────────────────────
  const r = await athena.generate(prompt, {
    maxSteps: 6,
    threadId: event.threadId,
    resourceId: event.resourceId,
  });
  console.log("[agent] done:", r.text.slice(0, 400));
}
