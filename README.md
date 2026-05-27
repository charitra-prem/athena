# Athena

A long-running AI agent with persistent identity that wakes on external events
(Slack mentions, emails, …), acts once, and exits. Each wake runs in an
isolated Vercel Sandbox booted from a snapshot in ~3 seconds. Sources are
pluggable: Slack is wired today, Gmail/Nango/Composio adapters scaffolded.

## Architecture

```
   ┌──────────────────┐
   │   any source     │  (Slack Events, Gmail Pub/Sub, Nango, raw curl, …)
   └─────────┬────────┘
             │ POST vendor-shaped payload
             ▼
   ┌──────────────────────────┐
   │ /api/sources/{vendor}.ts │  Vendor adapter: verify signature,
   │                          │  translate to { source, type, data } envelope
   └─────────┬────────────────┘
             │ waitUntil → spawnSandbox(envelope)
             ▼
   ┌──────────────────────────┐
   │      lib/spawn.ts        │  Boot Vercel Sandbox from snapshot,
   │                          │  write agent.ts, run it, return.
   └─────────┬────────────────┘
             │
             ▼
   ┌──────────────────────────┐
   │        agent.ts          │  Reads envelope, routes to source-specific
   │  (inside sandbox, once)  │  tools (Composio Gmail or direct Slack API),
   │                          │  acts, exits.
   └──────────────────────────┘
```

The contract between adapters and the sandbox is one normalized envelope:

```ts
{ source: "slack-events", type: "app_mention", data: { …event fields } }
```

Swap any source by adding/removing a file under `webhook/api/sources/`.
Nothing downstream of `lib/spawn.ts` cares which vendor caught the event.

## Repo layout

```
.
├── webhook/                      # deployed to Vercel
│   ├── api/
│   │   ├── wake.ts               # envelope-only broker (strict contract)
│   │   └── sources/
│   │       ├── slack.ts          # Slack Events API adapter (signature verify + waitUntil)
│   │       └── nango.ts          # Nango sync-webhook adapter (scaffolded)
│   ├── lib/spawn.ts              # sandbox core; the ONLY code that knows about Vercel Sandbox
│   ├── agent.ts                  # sandbox-side agent (copied here at deploy time)
│   └── vercel.json
├── agent.ts                      # canonical agent source (source of truth)
├── agent.package.json            # deps installed INSIDE the sandbox snapshot
├── bootstrap.ts                  # one-time: build & snapshot the sandbox image
├── dashboard.ts                  # local web dashboard (localhost:7878), SSE log stream
├── status.ts                     # terminal status dump
└── spawn.ts                      # one-shot test spawn from your laptop
```

## Sources

| Source                  | File                             | Status              |
| ----------------------- | -------------------------------- | ------------------- |
| Slack Events API        | `webhook/api/sources/slack.ts`   | ✅ live, end-to-end |
| Nango (Gmail/anything)  | `webhook/api/sources/nango.ts`   | scaffolded, needs Nango setup |
| Gmail Pub/Sub (direct)  | —                                | TODO — needs GCP billing |
| Raw envelope (curl/etc) | `webhook/api/wake.ts`            | ✅ accepts `{source,type,data}` directly |

## Quick start

```sh
bun install
cp .env.example .env  # fill in tokens
bun run bootstrap     # builds the sandbox snapshot, prints SANDBOX_SNAPSHOT_ID
# add SANDBOX_SNAPSHOT_ID to .env
cd webhook && npx vercel deploy --prod
```

### Local helpers

- `bun run spawn` — one-shot test spawn from your laptop
- `bun run dashboard` — opens localhost:7878 with live sandbox/Composio/OpenRouter state
- `bun run status` — terminal snapshot of the same

## Required env

On Vercel (function side):

```
VERCEL_TOKEN
VERCEL_TEAM_ID
VERCEL_PROJECT_ID
SANDBOX_SNAPSHOT_ID
OPENROUTER_API_KEY
COMPOSIO_API_KEY
AGENT_USER_ID            # Composio user id
AGENT_EMAIL              # mailbox the agent owns (for self-loop guard)
SLACK_SIGNING_SECRET     # for /api/sources/slack signature verify
SLACK_BOT_TOKEN          # xoxb-… for chat.postMessage
SLACK_BOT_USER_ID        # U… for self-message skip
```

`spawn.ts` passes the agent-relevant subset into the sandbox env at boot.

## Adding a new source

1. Drop a file `webhook/api/sources/<name>.ts`.
2. Verify the vendor signature, then translate the payload into the envelope.
3. Call `await spawnSandbox(envelope)` (or wrap in `waitUntil()` if the vendor
   expects an ack inside 3s and your spawn takes longer).
4. Add it to `vercel.json` `functions` block with `includeFiles: "agent.ts"`.
5. Add a branch in `agent.ts` that loads source-appropriate tools.

That's the whole contract.

## Notes / gotchas

- Vercel functions kill the process at `res.end()` — dangling `.catch()`
  promises die. Use `waitUntil(...)` from `@vercel/functions` for
  fire-and-forget spawns.
- ESM relative imports inside Vercel TS functions need the `.js` extension
  (`from "../lib/spawn.js"`), not `.ts`.
- `--experimental-strip-types` runs `agent.ts` inside the sandbox.
- Mastra v1.36 passes tool input as the first arg directly (`async (input) => …`),
  not wrapped in `{ context }`.
- Vercel SDK's `Sandbox.create` reads `dispatcher` from `init` — wrap `fetch`
  to strip it on Node 26 to avoid brotli-decoding bugs.
