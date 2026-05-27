# Athena

A long-running AI agent that wakes on external events (Slack mentions, future:
Gmail, …), runs once in a fresh Vercel Sandbox booted from snapshot in ~3
seconds, acts, and exits.

## Architecture

```
   ┌──────────────────┐
   │   any source     │  (Slack Events, Gmail Pub/Sub, raw curl, …)
   └─────────┬────────┘
             │ vendor-shaped POST
             ▼
   ┌──────────────────────────┐
   │ api/sources/{vendor}.ts  │  verify signature, translate to envelope
   └─────────┬────────────────┘
             │ waitUntil(spawnSandbox(envelope))
             ▼
   ┌──────────────────────────┐
   │      lib/spawn.ts        │  boot sandbox from snapshot, run agent.ts
   └─────────┬────────────────┘
             │
             ▼
   ┌──────────────────────────┐
   │        agent.ts          │  read envelope, pick tools, act once, exit
   └──────────────────────────┘
```

The contract between adapters and the sandbox is one normalized envelope:

```ts
{ source: "slack-events", type: "app_mention", data: { …event fields } }
```

Add a source = drop a file in `api/sources/`. Nothing downstream of
`lib/spawn.ts` cares which vendor caught the event.

## Files

```
.
├── api/
│   ├── wake.ts             # envelope-only broker (strict contract)
│   └── sources/
│       └── slack.ts        # Slack Events API adapter
├── lib/spawn.ts            # sandbox core; the only code that knows Vercel Sandbox
├── agent.ts                # runs inside the sandbox, once per event
├── agent.package.json      # deps installed inside the sandbox snapshot
├── bootstrap.ts            # one-time: build & snapshot the sandbox image
└── vercel.json
```

## Quick start

```sh
bun install
cp .env.example .env   # fill in tokens
bun run bootstrap      # prints SANDBOX_SNAPSHOT_ID — add it to .env
bun run deploy         # deploy to Vercel
```

## Required env

```
VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
SANDBOX_SNAPSHOT_ID            # from `bun run bootstrap`
OPENROUTER_API_KEY
COMPOSIO_API_KEY               # for Gmail toolkit
AGENT_USER_ID                  # Composio user id
AGENT_EMAIL                    # mailbox the agent owns (self-loop guard)
SLACK_SIGNING_SECRET           # Slack adapter signature verify
SLACK_BOT_TOKEN                # xoxb-… for chat.postMessage
SLACK_BOT_USER_ID              # U… for self-message skip
```

## Adding a source

1. Drop `api/sources/<name>.ts`. Verify the vendor signature, translate to the
   envelope, call `waitUntil(spawnSandbox(envelope))`.
2. Add a branch in `agent.ts` that loads source-appropriate tools.
3. Register in `vercel.json` `functions` block with `includeFiles: "agent.ts"`.

## Gotchas

- Vercel kills the process at `res.end()`. Dangling `.catch()` promises die.
  Use `waitUntil()` from `@vercel/functions` for fire-and-forget spawns.
- ESM relative imports inside Vercel TS functions need the `.js` extension
  (`from "../lib/spawn.js"`), not `.ts`.
- Mastra v1.36 passes tool input as the first arg directly
  (`async (input) => …`), not wrapped in `{ context }`.
- Vercel SDK's `Sandbox.create` reads `dispatcher` from `init` — wrap `fetch`
  to strip it on Node 26 to avoid brotli-decoding bugs.
