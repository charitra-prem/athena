// Thin Upstash Redis REST wrapper. Used to persist per-thread sandbox state
// (live sandboxId, current snapshotId, keep-alive expiry).
//
// Mastra Memory uses the same Upstash instance via @mastra/upstash inside the
// sandbox — but that's a separate import; this file is for our control plane
// (the broker function), not the agent.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function assertConfigured(): void {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error(
      "Upstash not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN on the function env. " +
        "Provision via `vercel kv create athena-state` (which uses Upstash under the hood) or sign up directly at upstash.com.",
    );
  }
}

async function call(args: (string | number)[]): Promise<any> {
  assertConfigured();
  const r = await fetch(REDIS_URL!, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`upstash ${r.status}: ${await r.text()}`);
  const j = (await r.json()) as { result?: unknown; error?: string };
  if (j.error) throw new Error(`upstash: ${j.error}`);
  return j.result;
}

export function isKvConfigured(): boolean {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

export const kv = {
  async get<T = unknown>(key: string): Promise<T | null> {
    const raw = (await call(["GET", key])) as string | null;
    if (raw == null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as unknown as T;
    }
  },

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    if (ttlSeconds) await call(["SET", key, raw, "EX", ttlSeconds]);
    else await call(["SET", key, raw]);
  },

  async del(key: string): Promise<void> {
    await call(["DEL", key]);
  },
};
