// Self-contained HTML sign-in page. Points users at Clerk's hosted Account
// Portal. v1: instructional — user pastes the slack id into their profile's
// unsafe_metadata after sign-in. Full OAuth-style auto-link is a follow-up.
import type { VercelRequest, VercelResponse } from "@vercel/node";

function deriveFrontendApi(publishableKey: string): string {
  // pk_(test|live)_<base64> — base64 decodes to "<frontend>$"
  const b64 = publishableKey.split("_").slice(2).join("_");
  return Buffer.from(b64, "base64").toString("utf-8").replace(/\$$/, "");
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  const slack = typeof req.query.slack === "string" ? req.query.slack : "";
  const frontend = deriveFrontendApi(process.env.CLERK_PUBLISHABLE_KEY ?? "");
  const signInUrl = frontend ? `https://${frontend}/sign-in` : "#";
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><title>Link your Slack account</title>
<style>body{font:14px/1.5 system-ui;max-width:560px;margin:4rem auto;padding:0 1rem}code{background:#f4f4f4;padding:2px 6px;border-radius:4px}</style>
<h1>Link your Slack account</h1>
<p>To finish linking, sign in to Athena and add this value to your Clerk profile's <code>unsafe_metadata.slack_user_id</code> field:</p>
<p><code>${esc(slack)}</code></p>
<p><a href="${esc(signInUrl)}">Continue to sign in</a></p>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(html);
}
