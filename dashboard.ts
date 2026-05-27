// Runs LOCALLY. Live web dashboard at http://localhost:7878.
// Polls Vercel + Composio + OpenRouter every 3s; streams running-sandbox stdout via SSE.
import http from "node:http";

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
  fetch(`https://backend.composio.dev${p}`, { headers: { "x-api-key": COMP } }).then((r) => r.json());
const or = (p: string) =>
  fetch(`https://openrouter.ai${p}`, { headers: { Authorization: `Bearer ${OR}` } }).then((r) => r.json());

// ── SSE fanout ────────────────────────────────────────────────────────
const clients = new Set<http.ServerResponse>();
const send = (ev: string, data: unknown) => {
  const msg = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
};

// ── Log stream registry ───────────────────────────────────────────────
const streaming = new Map<string, AbortController>();
async function streamCmd(sandboxId: string, cmdId: string) {
  const k = `${sandboxId}/${cmdId}`;
  if (streaming.has(k)) return;
  const ctrl = new AbortController();
  streaming.set(k, ctrl);
  try {
    const r = await fetch(
      `https://api.vercel.com/v1/sandboxes/${sandboxId}/cmd/${cmdId}/logs?teamId=${TEAM}`,
      { headers: { Authorization: `Bearer ${VTOK}` }, signal: ctrl.signal },
    );
    if (!r.body) return;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const j = JSON.parse(line);
          send("log", { sandboxId, cmdId, stream: j.stream, line: j.data });
        } catch {}
      }
    }
  } catch {} finally {
    streaming.delete(k);
    send("log-end", { sandboxId, cmdId });
  }
}

// ── Snapshot loop ─────────────────────────────────────────────────────
async function snapshot() {
  try {
    const [sbxes, conns, triggers, key] = await Promise.all([
      v(`/v1/sandboxes?project=${PROJECT}&limit=10`),
      c(`/api/v3/connected_accounts?user_ids=${USER}&limit=20`),
      c(`/api/v3/trigger_instances/active?user_ids=${USER}&limit=20`),
      or(`/api/v1/auth/key`),
    ]);

    // Enrich each running sandbox with its commands, and start streaming any new running cmd.
    const enriched = await Promise.all(
      (sbxes.sandboxes ?? []).map(async (s: any) => {
        if (s.status !== "running" && s.status !== "stopping") return { ...s, cmds: [] };
        const cmds = await v(`/v1/sandboxes/${s.id}/cmd`);
        const list = Array.isArray(cmds) ? cmds : [];
        for (const cm of list) if (cm.exitCode == null) streamCmd(s.id, cm.id);
        return { ...s, cmds: list };
      }),
    );

    send("snapshot", {
      time: Date.now(),
      sandboxes: enriched,
      composioConnections: conns.items ?? [],
      composioTriggers: triggers.items ?? [],
      openrouter: key.data ?? {},
    });
  } catch (e) {
    send("snapshot-err", String(e));
  }
}

// ── HTML page ─────────────────────────────────────────────────────────
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Athena Dashboard</title>
<style>
  body{font:13px ui-monospace,monospace;background:#0b0d12;color:#d4d8e0;margin:0;padding:16px}
  h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#7d8aa3;margin:18px 0 6px;border-bottom:1px solid #1f2632;padding-bottom:4px}
  .row{display:grid;grid-template-columns:1.2fr 1fr;gap:18px;align-items:start}
  .card{background:#11151c;border:1px solid #1f2632;border-radius:8px;padding:10px}
  .sbx{padding:8px 0;border-bottom:1px solid #1f2632}.sbx:last-child{border-bottom:0}
  .pill{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;margin-right:6px}
  .running{background:#163d2a;color:#7be0a8}.stopped{background:#2b1d1d;color:#e07b7b}
  .stopping{background:#3d3416;color:#e0d07b}.pending{background:#163b4f;color:#7bc4e0}
  .id{color:#7d8aa3;font-size:11px}
  .cmd{padding:2px 0;margin-left:14px;color:#a3b1c4}.cmd .ex{color:#7d8aa3;margin-left:6px}
  pre.log{background:#070a0e;border:1px solid #1f2632;padding:8px;border-radius:6px;height:60vh;overflow:auto;font-size:12px;margin:0;white-space:pre-wrap}
  .stderr{color:#e0a37b}.meta{color:#7d8aa3}.k{color:#7d8aa3}.v{color:#d4d8e0}
  table{width:100%;border-collapse:collapse}td{padding:2px 6px;font-size:12px}
  td.k{color:#7d8aa3;width:30%}
</style></head><body>
<h2>Athena dashboard <span class="meta" id="t"></span></h2>
<div class="row">
  <div>
    <h2>Vercel Sandboxes</h2><div class="card" id="sbx">…</div>
    <h2>Composio</h2><div class="card" id="comp">…</div>
    <h2>OpenRouter</h2><div class="card" id="or">…</div>
  </div>
  <div>
    <h2>Live agent stdout</h2><pre class="log" id="log"></pre>
  </div>
</div>
<script>
const $=id=>document.getElementById(id);
const known=new Set(),knownCmd=new Set();
const log=$('log');
function append(line,cls){const d=document.createElement('div');if(cls)d.className=cls;d.textContent=line;log.appendChild(d);log.scrollTop=log.scrollHeight}
function fmt(b){return b==null?'?':(b/1048576).toFixed(1)+' MB'}
function ago(t){return t?Math.floor((Date.now()-t)/1000)+'s':'?'}
const es=new EventSource('/events');
es.addEventListener('snapshot',e=>{
  const d=JSON.parse(e.data);
  $('t').textContent='· '+new Date(d.time).toLocaleTimeString();
  // Sandboxes
  let h='';
  for(const s of d.sandboxes){
    if(!known.has(s.id)){known.add(s.id);append('★ new sandbox '+s.id,'meta')}
    h+='<div class="sbx"><span class="pill '+s.status+'">'+s.status+'</span><span class="id">'+s.id+'</span>'
     + ' <span class="meta">'+s.vcpus+'vCPU '+s.memory+'MB · cpu '+(s.activeCpuDurationMs??'?')+'ms · net ↑'+fmt(s.networkTransfer?.egress)+' ↓'+fmt(s.networkTransfer?.ingress)+' · age '+ago(s.startedAt)+'</span>';
    for(const cm of (s.cmds||[]).slice(-6)){
      const k=s.id+'/'+cm.id;if(!knownCmd.has(k)){knownCmd.add(k);append('★ cmd '+cm.name+' '+(cm.args||[]).join(' '),'meta')}
      h+='<div class="cmd">└ '+cm.name+' '+((cm.args||[]).join(' ')||'').slice(0,60)+'<span class="ex">'+(cm.exitCode==null?'running':'exit='+cm.exitCode)+'</span></div>';
    }
    h+='</div>';
  }
  $('sbx').innerHTML=h||'<span class="meta">no sandboxes</span>';
  // Composio
  let ch='<table>';
  ch+='<tr><td colspan=2 class="k">connections</td></tr>';
  for(const x of d.composioConnections){ch+='<tr><td class="k">'+x.toolkit?.slug+'</td><td class="v">user='+x.user_id+' · '+x.status+'</td></tr>'}
  ch+='<tr><td colspan=2 class="k" style="padding-top:6px">active triggers</td></tr>';
  for(const t of d.composioTriggers){ch+='<tr><td class="k">'+(t.trigger_name||'?')+'</td><td class="v">'+t.id+' · '+(t.disabled_at?'disabled':'active')+'</td></tr>'}
  $('comp').innerHTML=ch+'</table>';
  // OR
  const k=d.openrouter;
  $('or').innerHTML='<table>'
   +'<tr><td class="k">usage</td><td class="v">$'+(k.usage??0).toFixed(4)+'</td></tr>'
   +'<tr><td class="k">limit</td><td class="v">'+(k.limit??'∞')+'</td></tr>'
   +'<tr><td class="k">remaining</td><td class="v">'+(k.limit_remaining??'∞')+'</td></tr>'
   +'</table>';
});
es.addEventListener('log',e=>{const d=JSON.parse(e.data);append(d.line.replace(/\\n$/,''),d.stream==='stderr'?'stderr':null)});
es.addEventListener('log-end',e=>{const d=JSON.parse(e.data);append('— stream ended ('+d.cmdId+') —','meta')});
</script></body></html>`;

// ── HTTP server ───────────────────────────────────────────────────────
const PORT = 7878;
http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(HTML);
  } else if (req.url === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    });
    clients.add(res);
    req.on("close", () => clients.delete(res));
    snapshot(); // immediate first push
  } else {
    res.writeHead(404).end();
  }
}).listen(PORT, () => console.log(`dashboard: http://localhost:${PORT}`));

setInterval(snapshot, 3000);
snapshot();
