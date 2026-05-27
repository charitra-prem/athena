// Sign-in page. Renders Clerk's hosted sign-in widget (magic link / email /
// social). After auth completes, client-side JS calls /api/link-slack with
// the slack id from the URL; the backend verifies the Clerk session and
// writes the user-link mapping. No copy-paste, no profile-metadata edits.
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(req: VercelRequest, res: VercelResponse) {
  const slack = typeof req.query.slack === "string" ? req.query.slack : "";
  const pk = process.env.CLERK_PUBLISHABLE_KEY ?? "";
  if (!slack || !slack.includes(":")) {
    return res.status(400).send("missing or malformed ?slack=<team>:<user>");
  }
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
<p class="sub">Sign in below. Your Slack identity <code>${esc(slack)}</code> is linked automatically when auth completes.</p>
<div id="clerk-target"></div>
<div id="status"></div>
<script src="https://${frontendApi}/npm/@clerk/clerk-js@5/dist/clerk.browser.js"
        data-clerk-publishable-key="${esc(pk)}"
        crossorigin="anonymous"
        async></script>
<script>
const SLACK = ${JSON.stringify(slack)};
const setStatus = (msg, cls) => {
  const el = document.getElementById("status");
  el.className = "status " + (cls || "");
  el.textContent = msg;
};
async function linkSlack() {
  setStatus("Linking your Slack identity…");
  const token = await window.Clerk.session.getToken();
  const r = await fetch("/api/link-slack", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ slack: SLACK }),
  });
  if (r.ok) {
    document.getElementById("clerk-target").style.display = "none";
    setStatus("Linked. You can close this tab and return to Slack.", "ok");
  } else {
    setStatus("Link failed: " + (await r.text()), "err");
  }
}
window.addEventListener("load", async () => {
  const waitForClerk = () => new Promise((r) => {
    if (window.Clerk) return r();
    const i = setInterval(() => { if (window.Clerk) { clearInterval(i); r(); } }, 50);
  });
  await waitForClerk();
  await window.Clerk.load();
  if (window.Clerk.user) {
    await linkSlack();
    return;
  }
  window.Clerk.mountSignIn(document.getElementById("clerk-target"), {
    forceRedirectUrl: window.location.href,
  });
  window.Clerk.addListener(async ({ session }) => {
    if (session) await linkSlack();
  });
});
</script>
</body></html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
