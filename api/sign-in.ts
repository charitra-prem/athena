// Sign-in page + post-OAuth landing.
//
// Two entry paths land here:
//   1. /api/sign-in?slack=<team>:<user> — first visit (from the slash command)
//   2. / (root, rewritten via vercel.json) — Clerk OAuth providers redirect
//      back to the app's origin; they don't preserve our query, so we recover
//      the slack id from sessionStorage stashed at step 1.
//
// In both cases the same page is rendered and the same script runs.
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(req: VercelRequest, res: VercelResponse) {
  const queryslack = typeof req.query.slack === "string" ? req.query.slack : "";
  const pk = (process.env.CLERK_PUBLISHABLE_KEY ?? "").trim();
  if (!pk) return res.status(500).send("CLERK_PUBLISHABLE_KEY not set");

  // Derive Clerk frontend API host from publishable key (pk_(test|live)_<base64>$).
  const b64 = pk.split("_").slice(2).join("_");
  const frontendApi = Buffer.from(b64, "base64").toString("utf-8").replace(/\$$/, "");
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Sign in to Athena</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; max-width: 460px; margin: 3rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin-bottom: 0.5rem; }
  .sub { color: #555; margin-bottom: 1.5rem; }
  code { background: #f4f4f4; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  .status { padding: 1rem; border-radius: 6px; margin-top: 1rem; }
  .status.ok { background: #e6f4ea; color: #166534; }
  .status.err { background: #fce8e6; color: #8a1f1f; }
</style>
</head><body>
<h1>Link Slack to Athena</h1>
<p class="sub" id="sub">Loading…</p>
<div id="clerk-target"></div>
<div id="status"></div>
<script src="https://${frontendApi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
        data-clerk-publishable-key="${esc(pk)}"
        crossorigin="anonymous"
        async></script>
<script>
const QUERY_SLACK = ${JSON.stringify(queryslack)};
const STORAGE_KEY = "athena_slack_link";
const setStatus = (msg, cls) => {
  const el = document.getElementById("status");
  el.className = "status " + (cls || "");
  el.textContent = msg;
};
const setSub = (msg) => { document.getElementById("sub").textContent = msg; };

// Resolve the slack id: prefer URL ?slack=, fall back to sessionStorage stash.
function resolveSlack() {
  if (QUERY_SLACK && QUERY_SLACK.includes(":")) {
    try { sessionStorage.setItem(STORAGE_KEY, QUERY_SLACK); } catch (_) {}
    return QUERY_SLACK;
  }
  try { return sessionStorage.getItem(STORAGE_KEY) || ""; } catch (_) { return ""; }
}

async function linkSlack(slack) {
  setStatus("Linking your Slack identity…");
  const token = await window.Clerk.session.getToken();
  const r = await fetch("/api/link-slack", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ slack }),
  });
  if (r.ok) {
    document.getElementById("clerk-target").style.display = "none";
    setStatus("Linked. You can close this tab and return to Slack.", "ok");
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {}
  } else {
    setStatus("Link failed: " + (await r.text()), "err");
  }
}

window.addEventListener("load", async () => {
  const slack = resolveSlack();
  if (!slack) {
    setSub("Missing Slack identity.");
    setStatus("Run /athena-login from Slack to get a sign-in link.", "err");
    return;
  }
  setSub("Sign in below. Slack identity " + slack + " is linked automatically when auth completes.");

  const waitForClerk = () => new Promise((r) => {
    if (window.Clerk) return r();
    const i = setInterval(() => { if (window.Clerk) { clearInterval(i); r(); } }, 50);
  });
  await waitForClerk();
  await window.Clerk.load();

  if (window.Clerk.user) {
    await linkSlack(slack);
    return;
  }
  window.Clerk.mountSignIn(document.getElementById("clerk-target"), {
    forceRedirectUrl: window.location.origin + "/",
  });
  window.Clerk.addListener(async ({ session }) => {
    if (session) await linkSlack(slack);
  });
});
</script>
</body></html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
