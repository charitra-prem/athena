// Identity resolution + RBAC for Athena. Maps an inbound Envelope to an
// { orgId, userId } pair the rest of the system can authorize against,
// and provides a pure path-based access check.
//
// Two KV mappings drive linkage to Clerk (both keyed on envelope.orgId):
//   org-link:<orgId>                  -> clerk_org_id
//   user-link:<orgId>:<source-user>   -> clerk_user_id
//
// Both mappings are optional. With no org-link, orgId falls back to
// envelope.orgId (e.g. "slack:T123") so unlinked workspaces still get
// per-workspace isolation. With no user-link, userId is null
// (anonymous-within-org).

import { createClerkClient } from "@clerk/backend";
import { kv } from "./kv.js";
import type { Envelope } from "./spawn.js";

export type Identity = {
  orgId: string;       // Clerk org_id if linked, else fallback "<source>:<source-key>".
  userId: string | null;
};

let clerkClient: ReturnType<typeof createClerkClient> | null = null;
function getClerk() {
  if (clerkClient) return clerkClient;
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "Clerk not configured. Set CLERK_SECRET_KEY on the function env to validate linked orgs.",
    );
  }
  clerkClient = createClerkClient({ secretKey });
  return clerkClient;
}

export async function resolveIdentity(env: Envelope): Promise<Identity> {
  // envelope.orgId already encodes the workspace ("slack:T123"). Reuse it
  // as both the lookup key for the Clerk mapping and the fallback orgId.
  const sourceKey = env.orgId;

  // Source-user lookup is source-specific. Slack puts it in data.user.
  const sourceUser =
    typeof env.data?.user === "string" ? (env.data.user as string) : null;

  const linkedOrgId = await kv.get<string>(`org-link:${sourceKey}`);

  let orgId = sourceKey;
  if (linkedOrgId) {
    try {
      // Validate the mapping actually points at a live Clerk org.
      await getClerk().organizations.getOrganization({ organizationId: linkedOrgId });
      orgId = linkedOrgId;
    } catch (e: any) {
      console.warn(
        `[identity] clerk org ${linkedOrgId} validation failed, falling back to ${sourceKey}: ${e?.message ?? e}`,
      );
    }
  }

  let userId: string | null = null;
  if (sourceUser) {
    const linkedUserId = await kv.get<string>(`user-link:${sourceKey}:${sourceUser}`);
    if (linkedUserId) userId = linkedUserId;
  }

  return { orgId, userId };
}

export function canAccess(path: string, id: Identity): boolean {
  const [bucket, orgId, tier, target] = path.split("/");
  if (bucket !== "orgs") return false;
  if (orgId !== id.orgId) return false;
  if (tier === "users") return target === id.userId;
  return tier === "org" || tier === "projects";
}
