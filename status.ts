// Runs LOCALLY. One screen, every 5s: Vercel sandboxes + commands + log tail,
// Composio connections + triggers, OpenRouter usage. Ctrl-C to exit.
const TEAM = process.env.VERCEL_TEAM_ID!;
const PROJECT = process.env.VERCEL_PROJECT_ID!;
const VTOK = process.env.VERCEL_TOKEN!;
const COMP = process.env.COMPOSIO_API_KEY!;
const OR = process.env.OPENROUTER_API_KEY!;
const USER = process.env.AGENT_USER_ID!;

const v = (p: string) =>
  fetch(`https://api.vercel.com${p}${p.includes("?") ? "&" : "?"}teamId=${TEAM}`, {
    headers: { Authorization: `Bearer ${VTOK}` },
  }).then((r) => r.json());

const c = (p: string) =>
  fetch(`https://backend.composio.dev${p}`, { headers: { "x-api-key": COMP } }).then((r) =>
    r.json(),
  );

const or = (p: string) =>
  fetch(`https://openrouter.ai${p}`, { headers: { Authorization: `Bearer ${OR}` } }).then((r) =>
    r.json(),
  );

const fmt = (b?: number) => (b == null ? "?" : `${(b / 1024 / 1024).toFixed(1)} MB`);
const ms = (d?: number) =>
  d == null ? "?" : `${Math.floor((Date.now() - d) / 1000)}s ago`;
const ago = (iso?: string) => (iso ? ms(new Date(iso).getTime()) : "?");

async function tick() {
  const [sbxes, conns, triggers, key] = await Promise.all([
    v(`/v1/sandboxes?project=${PROJECT}&limit=5`),
    c(`/api/v3/connected_accounts?user_ids=${USER}&limit=20`),
    c(`/api/v3/trigger_instances/active?user_ids=${USER}&limit=20`),
    or(`/api/v1/auth/key`),
  ]);

  console.clear();
  console.log(`── ${new Date().toLocaleTimeString()} ──`);

  console.log("\n[ VERCEL SANDBOXES ]");
  for (const s of sbxes.sandboxes ?? []) {
    console.log(
      `  ${s.id}  ${s.status.padEnd(10)} ${s.vcpus}vCPU ${s.memory}MB  cpu=${
        s.activeCpuDurationMs ?? "?"
      }ms  net↑${fmt(s.networkTransfer?.egress)} ↓${fmt(s.networkTransfer?.ingress)}  age ${ms(
        s.startedAt,
      )}`,
    );
    // Commands inside this sandbox (last 5)
    if (s.status === "running" || s.status === "stopping") {
      const cmds = await v(`/v1/sandboxes/${s.id}/cmd`);
      const list = (cmds || []).slice(-5);
      for (const cm of list) {
        const ex = cm.exitCode == null ? "running" : `exit=${cm.exitCode}`;
        console.log(`    └ ${cm.name} ${(cm.args || []).join(" ").slice(0, 50)}  ${ex}`);
      }
      // Tail the latest still-running command (probably agent.ts)
      const live = [...list].reverse().find((c: any) => c.exitCode == null);
      if (live) {
        const r = await fetch(
          `https://api.vercel.com/v1/sandboxes/${s.id}/cmd/${live.id}/logs?teamId=${TEAM}`,
          { headers: { Authorization: `Bearer ${VTOK}` }, signal: AbortSignal.timeout(2000) },
        ).catch(() => null);
        if (r?.ok) {
          const txt = await r.text();
          const lines = txt
            .trim()
            .split("\n")
            .slice(-4)
            .map((l) => {
              try {
                return JSON.parse(l).data?.trim();
              } catch {
                return l;
              }
            })
            .filter(Boolean);
          for (const ln of lines) console.log(`      | ${ln.slice(0, 100)}`);
        }
      }
    }
  }

  console.log("\n[ COMPOSIO CONNECTIONS ]");
  for (const x of conns.items ?? []) {
    console.log(`  ${x.toolkit?.slug?.padEnd(12)} user=${x.user_id?.padEnd(12)} ${x.status}`);
  }

  console.log("\n[ COMPOSIO TRIGGERS ]");
  for (const t of triggers.items ?? []) {
    console.log(
      `  ${t.id} ${t.trigger_name?.padEnd(28)} user=${t.user_id?.padEnd(10)} ${
        t.disabled_at ? "DISABLED " + ago(t.disabled_at) : "active"
      }`,
    );
  }

  console.log("\n[ OPENROUTER ]");
  const d = key.data ?? {};
  console.log(
    `  usage=$${d.usage?.toFixed(4) ?? "?"}  limit=${d.limit ?? "∞"}  remaining=${
      d.limit_remaining ?? "∞"
    }  rate-limit=${JSON.stringify(d.rate_limit ?? {})}`,
  );
}

await tick();
setInterval(() => tick().catch((e) => console.error("tick err:", e.message)), 5000);
