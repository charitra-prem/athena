# Athena

Athena is a long-running AI agent that wakes on external events (Slack mentions today, Gmail / other sources next), runs once inside a freshly-booted Vercel Sandbox, acts, and exits. The agent process itself is stateless per event; durable state lives in Upstash Redis (conversation memory + per-thread sandbox bookkeeping) and in Vercel Sandbox snapshots (filesystem-level state per thread).

---

## 1. Architecture

```
   ┌──────────────────────────┐
   │ external source          │   Slack Events API, Gmail Pub/Sub,
   │ (vendor-shaped HTTP POST)│   raw curl from a test harness, …
   └────────────┬─────────────┘
                │
                ▼
   ┌──────────────────────────┐
   │ api/sources/<vendor>.ts  │   verify signature, ACK in <3s,
   │ (adapter)                │   canonicalize threadId,
   │                          │   build envelope, waitUntil(spawn)
   └────────────┬─────────────┘
                │  Envelope { source, type, threadId, data }
                ▼
   ┌──────────────────────────┐         ┌────────────────────────┐
   │ lib/spawn.ts             │◀────────│  Upstash Redis (KV)    │
   │ (broker / sandbox mgr)   │────────▶│  sandbox:<threadId>    │
   │                          │         │  → sandboxId, expires, │
   │                          │         │    snapshotId          │
   └────────────┬─────────────┘         └────────────────────────┘
                │
                │  Sandbox.create({ source: snapshot })
                │  + writeFiles agent.js
                │  + runCommand("node agent.js")
                ▼
   ┌──────────────────────────┐         ┌────────────────────────┐
   │ Vercel Sandbox           │         │  Upstash Redis +       │
   │  ─ agent.js              │◀───────▶│  Vector (Mastra Memory)│
   │  ─ skills/ (baked in)    │         │  threadId, "athena"    │
   │  ─ node_modules/         │         └────────────────────────┘
   │                          │
   │  Slack: stream agent.text │  ───▶ chat.startStream / appendStream /
   │         to chat.*Stream   │       stopStream (text streams live)
   │  Tool: shell              │  ───▶ skills under $SKILLS_DIR (slack, …)
   └────────────┬─────────────┘
                │  exit
                ▼
   ┌──────────────────────────┐
   │ lib/spawn.ts (continued) │   find -newer /tmp/run-start → dirty?
   │                          │   if dirty: snapshot + delete predecessor
   │                          │   update KV with new expiresAt
   └──────────────────────────┘
```

State map:

| Concern                       | Lives in                              | Keyed by                  |
| ----------------------------- | ------------------------------------- | ------------------------- |
| Conversation history (recency) | Upstash Redis + Vector (Mastra)      | `threadId`, `resourceId`  |
| Durable memory (org/project/user) | Vercel Blob (`orgs/<orgId>/…`)   | `orgId`, `userId` (Clerk) |
| Identity ↔ source mappings    | Upstash Redis (`org-link:…`, `user-link:…`) → Clerk | source-keyed |
| Per-thread sandbox bookkeeping | Upstash Redis (`sandbox:<threadId>`) | `threadId`                |
| Per-thread filesystem (work/, scratch) | Vercel Sandbox snapshot       | `threadId` (one snap max) |
| Base image (deps + skills)    | Vercel Sandbox snapshot               | `SANDBOX_SNAPSHOT_ID` env |

---

## 2. Envelope contract

`/api/wake.ts` and `lib/spawn.ts` accept exactly one shape. Vendor-specific payloads are translated upstream in `api/sources/<vendor>.ts`.

```ts
type Envelope = {
  source: string;        // "slack-events", later "gmail-pubsub", …
  type: string;          // "app_mention", "message", …
  threadId: string;      // one conversation
  resourceId: string;    // the "project" around it (channel-scoped for Slack)
  orgId: string;         // the workspace / tenant boundary
  data: Record<string, unknown>;
};
```

Canonicalization (from `api/sources/slack.ts`):

| Field        | Form                                                     | Example                                          |
| ------------ | -------------------------------------------------------- | ------------------------------------------------ |
| `threadId`   | `slack:<team_id>:<channel>:<thread_root_ts>`             | `slack:T123:C0B78ND1LQG:1779872551.798819`       |
| `resourceId` | `slack:<team_id>:<channel>` (no thread root)             | `slack:T123:C0B78ND1LQG`                         |
| `orgId`      | `slack:<team_id>` (workspace boundary)                   | `slack:T123`                                     |

Every thread in the same channel shares the same `resourceId`. Memory's `workingMemory` and `semanticRecall` are scoped to `resourceId`, so cross-thread context within a channel is recallable; `lastMessages` is `threadId`-scoped (verbatim tail of just this conversation).

Future sources should use the same `<source>:<source-specific-stable-key>` form for both. Anything that should reuse memory / a sandbox snapshot across messages MUST map to the same `threadId`.

POSTing a raw envelope to `/api/wake` (bypassing the adapter) is supported and intended for smoke tests:

```sh
curl -sS -X POST https://<deployment>/api/wake \
  -H 'content-type: application/json' \
  -H "x-ingest-secret: $INGEST_SECRET" \
  -d '{"source":"manual","type":"ping","threadId":"manual:t1","resourceId":"manual:default","orgId":"manual","data":{"text":"hi"}}'
```

---

## 3. Sandbox lifecycle per event

Implemented in `lib/spawn.ts:spawnSandbox`. Numbered to match the steps in the source.

1. **KV lookup** — `kv.get<ThreadState>("sandbox:" + threadId)` returns `{ sandboxId?, expiresAt?, snapshotId? }` or `null` for a brand-new thread.
2. **Warm reuse** — if `expiresAt > now`, call `Sandbox.get({ sandboxId })`. On success we skip the cold-start entirely. On failure (sandbox already reaped) we fall through to the cold path.
3. **Restore-from-snapshot** — `Sandbox.create({ source: { type: "snapshot", snapshotId: state.snapshotId ?? BASE_SNAPSHOT } })`. New thread → `BASE_SNAPSHOT`. Existing thread → its per-thread snapshot (which itself was forked from `BASE_SNAPSHOT`, so deps and skills are already inside).
4. **Upload agent.js** — every spawn re-writes `agent.js` from the pre-built `.build/agent.js` bundle. Cheap (~5.7 KB) and covers the case where a redeploy changed the agent between reuses.
5. **Mark run-start** — `touch /tmp/run-start` so we can `find -newer` later.
6. **Run agent (awaited)** — `sb.runCommand({ cmd: "node", args: ["agent.js"], env: { EVENT_PAYLOAD, THREAD_ID } })`. Not detached: the sandbox would otherwise refuse to auto-stop while the detached process is still alive.
7. **Dirty detection** — if the agent exited 0, run `find /vercel/sandbox/work /vercel/sandbox/node_modules /vercel/sandbox/.git -not -path '*/agent.js' -newer /tmp/run-start | head -1`. Non-empty stdout = "dirty". Reply-only conversations stay clean and skip the snapshot step entirely.
8. **Snapshot if dirty** — `sb.snapshot()` produces a new snapshotId. We immediately call `vercelDelete(/v1/snapshots/<previous>)` to GC the predecessor. Invariant: **at most one snapshot per thread**, plus the immutable `BASE_SNAPSHOT`.
9. **Update KV** — `kv.set("sandbox:<threadId>", { sandboxId, expiresAt: now + 60s, snapshotId }, ttl=7d)`. The 7-day KV TTL means a fully dormant thread drops out of the system.
10. **Do not stop the sandbox** — we let it die from its own `timeout: 90s`. The 60s keep-alive window inside KV always expires *before* the sandbox itself, so any follow-up event within 60s reattaches via `Sandbox.get` and gets a near-zero cold-start.

Constants (`lib/spawn.ts`):

```ts
const KEEP_ALIVE_MS = 60_000;          // reuse window for follow-ups
const SANDBOX_TIMEOUT_MS = 90_000;     // hard timeout — must exceed KEEP_ALIVE_MS
```

---

## 4. Memory

Mastra `Memory` is wired in `agent.ts` and runs **inside** the sandbox:

```ts
new Memory({
  storage: new UpstashStore({ id: "athena-store", url, token }),
  vector:  new UpstashVector({ id: "athena-vector", url, token }),
  embedder: openrouterEmbedder,
  options: {
    lastMessages:   10,
    semanticRecall: { topK: 3, messageRange: 2 },
    workingMemory:  { enabled: true },
  },
});
```

Tiers:

| Tier             | What it does                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `lastMessages`   | Verbatim tail of the last 10 messages in this thread.                                         |
| `semanticRecall` | Cosine-similar messages from any prior turn in the same `resourceId` — top-3, ±2 neighbours. |
| `workingMemory`  | A free-form scratchpad the agent can edit across turns within a thread.                       |

Storage and vector share one Upstash Redis instance (one provider, one token).

Embeddings go through **OpenRouter's `/embeddings` endpoint** (`openai/text-embedding-3-small`) via a hand-rolled AI-SDK-compatible embedder defined inline in `agent.ts`. Mastra's `Memory.embedder` only calls `.doEmbed({ values })`, so the 25-line shim is enough — no `@ai-sdk/openai` package, no extra provider keys.

Inference also goes through OpenRouter (`openrouter/deepseek/deepseek-v3.2`). One key (`OPENROUTER_API_KEY`) covers both inference and embeddings.

Memory has **two scopes**, both per envelope:

| Key          | Granularity                                | What's scoped to it                     |
| ------------ | ------------------------------------------ | --------------------------------------- |
| `threadId`   | one conversation (e.g. one Slack thread)   | `lastMessages` (verbatim recent tail)   |
| `resourceId` | the "project" around it (e.g. the channel) | `workingMemory` + `semanticRecall` pool |

`resourceId` for Slack is `slack:<team>:<channel>` — every thread in the same channel shares working-memory notes and is searchable via semantic recall. What Athena learns in one thread is therefore available to it in every other thread of the same channel.

### Durable memory (filesystem)

Cross-thread, cross-event, cross-sandbox memory lives in **Vercel Blob** under `orgs/<orgId>/...` and is mounted into each sandbox at `/vercel/sandbox/memory/` per event:

| Tier      | Blob namespace                          | Sandbox path                              |
| --------- | --------------------------------------- | ----------------------------------------- |
| Org       | `orgs/<orgId>/org/`                     | `/vercel/sandbox/memory/org/`             |
| Project   | `orgs/<orgId>/projects/<channel>/`      | `/vercel/sandbox/memory/projects/...`     |
| User      | `orgs/<orgId>/users/<userId>/`          | `/vercel/sandbox/memory/users/...`        |

Lifecycle per event (in `lib/spawn.ts`):

1. `resolveIdentity(envelope)` → `{ orgId, userId | null }`. `orgId` is the Clerk `org_id` if a link exists (`org-link:<orgId>` in KV → Clerk), else a fallback like `slack:T123`. `userId` is Clerk's `user_id` only when a `user-link:<orgId>:<sourceUser>` mapping exists.
2. `hydrate(envelope, identity)` lists the three blob prefixes in parallel, fetches each accessible file, composes `memory/CONTEXT.md` (org/project/user `facts.md` inlined + manifest of the rest), and returns the bundle.
3. Bundle is `sb.writeFiles`'d into the sandbox alongside `agent.js`.
4. Agent boots, reads `/vercel/sandbox/memory/CONTEXT.md` and prepends it to its instructions; uses `read`/`write`/`edit`/`grep`/`glob` against `/vercel/sandbox/memory/` for any deeper memory access.
5. After the agent exits successfully, `dehydrate(sb, envelope, identity, "/tmp/run-start")` runs `find -newer` against the memory tree and PUTs each modified file back to its blob key.

RBAC is enforced by `canAccess(path, identity)` in `lib/identity.ts` — a 6-line pure function applied before every blob list/get and every blob put. The sandbox never holds Blob or Clerk credentials.

`v1` write semantics: last-write-wins. A curator/compaction pass is the next iteration.

---

## 5. Agent tools

`agent.ts` exposes exactly **one** tool to the model. Delivery happens
outside the tool surface: for Slack events the agent's response text is
streamed live via `chat.startStream` / `appendStream` / `stopStream` (the
agent doesn't "call" a reply tool — it just generates text).

| Tool    | Signature           | When to use                                                                                                                          |
| ------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `shell` | `{ cmd: string }`   | ANY action that isn't the response itself — fetching thread context, reactions, user lookups, cross-channel posts, files, npm. 20s. |

`shell` is bash inside the sandbox. Skills are how the agent invokes
real services through it:

```sh
# Fetch the thread's recent messages for context
node $SKILLS_DIR/slack/bin/slack list <channel> --thread-ts <thread_id>

# React with an emoji
node $SKILLS_DIR/slack/bin/slack react <channel> <ts> <emoji>
```

The system prompt steers: just generate text for typical responses;
reach for `shell` only when an action is needed beyond the answer.
`maxSteps: 6` caps tool-use cycles.

Skills are **not** auto-loaded. The agent runs `cat $SKILLS_DIR/<name>/SKILL.md`
on first need to discover usage.

---

## 6. Skill packaging

Each skill is a self-contained directory under `skills/`:

```
skills/
├── slack/
│   ├── SKILL.md          ← human + agent-readable docs
│   └── bin/slack         ← executable CLI (Node, no deps beyond runtime)
└── google/
    └── SKILL.md          ← stub; not yet wired
```

Conventions:

- `SKILL.md` documents the CLI with subcommands, flags, examples, JSON-on-stdout contract, and exit codes (0 ok, 1 API error, 2 usage).
- `bin/<name>` is a Node script run as `node $SKILLS_DIR/<name>/bin/<name> …`. Skills get the sandbox's env (including `SLACK_BOT_TOKEN` etc.) for free.
- `$SKILLS_DIR` is set to `/vercel/sandbox/skills` in the spawn env (`lib/spawn.ts`).

Skills are baked into the `BASE_SNAPSHOT` by `bootstrap.ts`, **not** uploaded per spawn. That keeps per-event uploads to a single 5.7 KB `agent.js` write. To change a skill you must re-bootstrap (Section 11).

---

## 7. Required infrastructure

| Service          | Purpose                                                                 | Notes                                                                |
| ---------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Vercel project   | Hosts the broker (`api/wake`) and source adapters (`api/sources/*`).    | Also provides Sandboxes and snapshot storage. `node22` runtime.      |
| OpenRouter       | LLM inference (`deepseek-v3.2`) + embeddings (`text-embedding-3-small`).| One key covers both.                                                 |
| Upstash Redis    | KV (sandbox bookkeeping) + Mastra Memory storage + Vector store.        | Use Upstash directly or `vercel kv create athena-state`.             |
| Slack app        | Event Subscriptions → `/api/sources/slack`.                             | Bot scopes below.                                                    |

Slack app manifest scopes (derived from what `api/sources/slack.ts` and `skills/slack/bin/slack` actually call):

```yaml
display_information:
  name: Athena
features:
  bot_user:
    display_name: Athena
oauth_config:
  scopes:
    bot:
      - app_mentions:read   # receive @-mentions
      - chat:write          # post replies
      - chat:write.public   # post in channels without joining
      - channels:history    # conversations.replies / conversations.history
      - groups:history      # private channels
      - im:history          # DMs
      - im:read             # DM metadata
      - im:write            # initiate DMs
      - users:read          # users.info lookups (via shell + raw)
settings:
  event_subscriptions:
    request_url: https://<your-deployment>.vercel.app/api/sources/slack
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
```

---

## 8. Environment variables

Three layers consume env: the local CLI (`bootstrap.ts`), the Vercel functions (`api/*`), and the sandbox (forwarded via `Sandbox.create({ env })` in `lib/spawn.ts`).

| Variable                      | Where set                       | Used by                                                | Notes                                                                                  |
| ----------------------------- | ------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `VERCEL_TOKEN`                | Local `.env` + Vercel function  | `bootstrap.ts`, `lib/spawn.ts`                         | Account-level token; can create/delete sandboxes & snapshots.                          |
| `VERCEL_TEAM_ID`              | Local `.env` + Vercel function  | `bootstrap.ts`, `lib/spawn.ts`                         | `team_…`.                                                                              |
| `VERCEL_PROJECT_ID`           | Local `.env` + Vercel function  | `bootstrap.ts`, `lib/spawn.ts`                         | `prj_…`.                                                                               |
| `SANDBOX_SNAPSHOT_ID`         | Local `.env` + Vercel function  | `lib/spawn.ts` (`BASE_SNAPSHOT`)                       | Output of `bun run bootstrap`. Must be re-published whenever deps or skills change.    |
| `UPSTASH_REDIS_REST_URL`      | Vercel function + sandbox       | `lib/kv.ts`, `agent.ts` (Mastra Memory)                | REST endpoint.                                                                         |
| `UPSTASH_REDIS_REST_TOKEN`    | Vercel function + sandbox       | `lib/kv.ts`, `agent.ts`                                | Read-write token.                                                                      |
| `OPENROUTER_API_KEY`          | Vercel function + sandbox       | `agent.ts` (inference + embeddings)                    | Forwarded into sandbox env by `spawn`.                                                 |
| `OPENAI_API_KEY`              | Sandbox (optional)              | future skills                                          | Forwarded into sandbox env. Currently unused.                                          |
| `COMPOSIO_API_KEY`            | Sandbox (optional)              | future skills (Gmail toolkit)                          | Forwarded into sandbox env. Currently unused.                                          |
| `AGENT_USER_ID`               | Sandbox                         | future Composio-authed skills                          | Composio user id ("athena").                                                           |
| `AGENT_EMAIL`                 | Sandbox                         | self-loop guard for future Gmail source                |                                                                                        |
| `SLACK_SIGNING_SECRET`        | Vercel function                 | `api/sources/slack.ts` (signature verify)              | If unset, signature verification is skipped (dev only).                                |
| `SLACK_BOT_TOKEN`             | Vercel function + sandbox       | `agent.ts` (`slackApi`), `skills/slack/bin/slack`      | `xoxb-…`. Forwarded into sandbox.                                                      |
| `SLACK_BOT_USER_ID`           | Vercel function + sandbox       | `api/sources/slack.ts` (self-event skip)               | `U…`. Forwarded into sandbox.                                                          |
| `INGEST_SECRET`               | Vercel function                 | `api/wake.ts`                                          | Optional. If set, `x-ingest-secret` header must match.                                 |
| `BLOB_READ_WRITE_TOKEN`       | Vercel function                 | `lib/memory.ts` (hydrate/dehydrate)                    | Vercel Blob store token. Broker only — never forwarded to the sandbox.                 |
| `CLERK_PUBLISHABLE_KEY`       | Vercel function                 | `api/sign-in.tsx`                                      | Used only to derive the Clerk hosted sign-in URL.                                      |
| `CLERK_SECRET_KEY`            | Vercel function                 | `lib/identity.ts` (org validation)                     | Broker only. Validates linked Clerk orgs; not needed when running unlinked.            |
| `CLERK_WEBHOOK_SECRET`        | Vercel function                 | `api/clerk-webhook.ts`                                 | Svix shared secret for verifying inbound Clerk webhooks.                               |

"Vercel function" = set via `vercel env add …` (production environment).
"Sandbox" = forwarded into the sandbox by `lib/spawn.ts:spawnSandbox` — meaning **you set it on the Vercel function** and `spawn` propagates it. There is no separate sandbox env config.

`.env.example` is the source of truth for the local-dev minimum.

---

## 9. From zero to deployed

```sh
# a. Clone and install
git clone git@github.com:charitra-prem/athena.git
cd athena
bun install

# b. Fill local .env (copy .env.example, then set the values)
cp .env.example .env
$EDITOR .env
#   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
#   OPENROUTER_API_KEY
#   (Upstash + Slack creds optional for bootstrap, required for runtime)

# c. Build the base sandbox snapshot (npm-installs agent deps, copies skills/)
bun run bootstrap
#   prints: SANDBOX_SNAPSHOT_ID=snap_…
# Add it to .env.

# d. Deploy (predeploy hook runs build:agent → .build/agent.js, env vars)
bun run deploy
#   note the production URL, e.g. https://athena-foo.vercel.app

# e. Wire Slack
#   Go to api.slack.com → Your App → Event Subscriptions
#   Request URL: https://<deployment>/api/sources/slack
#   Slack POSTs a url_verification challenge; the adapter echoes the challenge back.

```

---

## 10. Adding a new source

1. **Drop the adapter file**: `api/sources/<vendor>.ts`.
   - Verify the vendor signature (e.g. HMAC for Slack; JWT for Gmail Pub/Sub).
   - ACK the vendor in `<3s` if they need it (`res.status(200).json(...)`).
   - Compute a canonical `threadId` of the form `<source>:<stable-key>`.
   - Build the `Envelope` and call `waitUntil(spawnSandbox(envelope))` — never await before `res.end()`.
2. **Register the function in `vercel.json`**: add the path under `functions` with `includeFiles: ".build/agent.js"` and a sensible `maxDuration` / `memory`.
3. **Network policy**: if the agent will hit a new domain (e.g. `gmail.googleapis.com`), add it to `networkPolicy.allow` in `lib/spawn.ts`.
4. **Delivery**: today only `slack-events` has wired delivery (streaming). For a new source, decide between (a) streaming via that vendor's equivalent API and wire it as an `else if (event.source.startsWith("<vendor>-"))` block in `agent.ts`, or (b) re-introduce a vendor-specific `reply` tool. Either way, only the `agent.ts` delivery block changes — the broker and KV layer stay untouched.
5. Redeploy. No bootstrap re-run needed unless you also added a skill.

---

## 11. Adding or modifying a skill

```sh
# 1. Drop a directory under skills/
mkdir -p skills/calendar/bin
$EDITOR skills/calendar/SKILL.md         # docs + CLI contract
$EDITOR skills/calendar/bin/calendar     # executable; chmod +x

# 2. Re-bootstrap (rebuilds the base snapshot with the new skill baked in)
bun run bootstrap
#   prints: SANDBOX_SNAPSHOT_ID=snap_NEW…

# 3. Publish the new snapshot id
$EDITOR .env                                              # update local
vercel env rm  SANDBOX_SNAPSHOT_ID production
vercel env add SANDBOX_SNAPSHOT_ID production             # paste snap_NEW…

# 4. Redeploy
bun run deploy
```

Existing per-thread snapshots will still reference the OLD base lineage until they're regenerated (they're independent forks). They will continue to work; new threads pick up the new base.

---

## 12. Local dev commands

| Command              | What it does                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `bun run typecheck`  | `tsc --noEmit` against `api/`, `lib/`, `bootstrap.ts`. No emit.                                    |
| `bun run build:agent`| Bun-bundles `agent.ts` to `.build/agent.js` (target node, ESM, externals preserved).               |
| `bun run bootstrap`  | Runs `build:agent`, then `tsx --env-file=.env bootstrap.ts` — provisions the base snapshot.        |
| `bun run deploy`     | `predeploy` runs `build:agent`; then `vercel deploy --prod --yes`.                                 |

CI (`.github/workflows/ci.yml`) runs `bun install --frozen-lockfile && bun run typecheck` on PRs and pushes to `main`.

---

## 13. Observability

**Adapter / broker logs** — standard Vercel function logs:

```sh
vercel logs <deployment-url> --follow | grep '\[slack\]'
# [slack] sbx=sbx_abc reused=true dirty=false total=1834ms
```

**Sandbox logs** — sandboxes are separate processes, not visible in `vercel logs`. Use the Vercel REST API:

```sh
# List sandboxes for the project
curl -sS "https://api.vercel.com/v1/sandboxes?teamId=$VERCEL_TEAM_ID&projectId=$VERCEL_PROJECT_ID" \
  -H "Authorization: Bearer $VERCEL_TOKEN" | jq

# List commands inside a sandbox
curl -sS "https://api.vercel.com/v1/sandboxes/<sandboxId>/cmd?teamId=$VERCEL_TEAM_ID" \
  -H "Authorization: Bearer $VERCEL_TOKEN" | jq

# Fetch logs for one command (stdout + stderr)
curl -sS "https://api.vercel.com/v1/sandboxes/<sandboxId>/cmd/<cmdId>/logs?teamId=$VERCEL_TEAM_ID" \
  -H "Authorization: Bearer $VERCEL_TOKEN"

# Stop a sandbox early
curl -sS -X POST "https://api.vercel.com/v1/sandboxes/<sandboxId>/stop?teamId=$VERCEL_TEAM_ID" \
  -H "Authorization: Bearer $VERCEL_TOKEN"
```

Inside the sandbox, `agent.ts` prefixes log lines for grep-ability: `[evt] …`, `[stream] start ts=…`, `[stream] stop ok=…`, `[shell] $ …`, `[agent] done: …`.

**KV inspection** — useful to debug "why didn't this reuse":

```sh
curl -sS "$UPSTASH_REDIS_REST_URL" \
  -H "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN" \
  -d '["GET","sandbox:slack:T123:C0B78ND1LQG:1779872551.798819"]'
```

---

## 14. Known gotchas

- **`waitUntil` is mandatory for fire-and-forget spawns.** Vercel kills the function process at `res.end()`. A dangling `spawnSandbox(envelope).catch(...)` will die before the sandbox boots. Use `waitUntil` from `@vercel/functions` (see `api/sources/slack.ts`).

- **ESM relative imports need the `.js` extension.** Vercel's TS function runtime uses NodeNext resolution, so `import { spawnSandbox } from "../../lib/spawn.js"` is correct — the `.js` is the *output* extension and required even though the file on disk is `.ts`.

- **Mastra v1.36 tool input shape.** `createTool({ execute })` receives the parsed input directly: `async (input) => …`. Older Mastra docs show `async ({ context }) => …`. We defensively support both: `input?.text ?? input?.context?.text`.

- **`Sandbox.create` mangles brotli ndjson on Node 26.** `@vercel/sandbox` passes a `dispatcher` field through to `fetch`, which interacts badly with Node 26's brotli decoder and shreds the ndjson stream. Every `Sandbox.*` call in this repo passes `fetch: cleanFetch` from `lib/clean-fetch.ts`, which strips `dispatcher` from the init.

- **`runCommand` return shape.** `CommandFinished.stdout` is an **async method**, not a property: `await cmd.stdout()`. `cmd.exitCode` is a property. Easy to get wrong.

- **Sandboxes don't auto-stop with detached processes.** A `runCommand({ detached: true })` keeps the sandbox alive until its hard timeout even after the function returns. We use **non-detached** `runCommand` so the sandbox can wind down naturally — combined with the explicit 90s `timeout`, this keeps idle-cost predictable.

- **Bun bundle, not `--experimental-strip-types`.** Earlier iterations tried running `agent.ts` directly via `node --experimental-strip-types`. That was flaky across Node versions. Current flow: `bun build agent.ts → .build/agent.js` (5.7 KB, externals preserved so `@mastra/*` etc. resolve from the snapshot's `node_modules`).

---

## 15. What's not done

- **Gmail source.** Skeleton at `skills/google/SKILL.md` only. Needs a GCP project with billing enabled to wire Pub/Sub → `/api/sources/gmail`.
- **Slack chat streaming.** The agent calls `chat.postMessage` once at the end. Streaming partial output via `chat.update` is deferred this iteration.
- **Snapshot GC sweeper for dormant threads.** KV entries expire after 7 days idle, but per-thread snapshots only get deleted on the *next* event for that thread. A standalone sweeper that lists snapshots and removes any whose KV entry is gone is the obvious next step.
- **Cross-source threads.** Today `threadId` is `<source>:…`. A user who DMs the bot and then emails it shows up as two unrelated threads. Wiring a global identity index (e.g. by user email) would let memory span sources.
- **Sub-agent spawning.** The agent has only `shell`. No structured tool for spawning a child agent / parallelizing work.
- **Multi-step durable workflows.** Anything that needs retries, fan-out, or scheduled follow-ups (e.g. "remind me in 2 hours") should live on a real workflow engine — Inngest or Temporal are the right layer above this. Athena is event → act-once → exit, deliberately.
- **Slack OAuth install callback.** Deferred. Until then, use `scripts/seed-org-link.ts <slack-team-id> <clerk-org-id>` to manually link a Slack workspace to a Clerk org.
