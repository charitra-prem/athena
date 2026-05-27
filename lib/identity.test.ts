// Tiny self-test for canAccess. Run with:
//   npx tsx --env-file=.env lib/identity.test.ts
import { canAccess, type Identity } from "./identity.js";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("assertion failed: " + msg);
}

const alice: Identity = { orgId: "org_A", userId: "user_alice" };
const anon: Identity = { orgId: "org_A", userId: null };

// 1. same-org user tier (allowed)
assert(canAccess("orgs/org_A/users/user_alice", alice), "alice can read her own user tier");

// 2. cross-org (denied)
assert(!canAccess("orgs/org_B/users/user_alice", alice), "alice cannot cross-org");

// 3. other-user user tier (denied)
assert(!canAccess("orgs/org_A/users/user_bob", alice), "alice cannot read bob's user tier");

// 4. org tier (allowed for any org member)
assert(canAccess("orgs/org_A/org/notes.md", alice), "alice can read org tier");

// 5. bad bucket (denied)
assert(!canAccess("foo/org_A/org/notes.md", alice), "non-orgs bucket denied");

// 6. null userId vs user tier (denied)
assert(!canAccess("orgs/org_A/users/user_alice", anon), "anon cannot match user tier");

// Extra: projects tier allowed for org member
assert(canAccess("orgs/org_A/projects/p1/file.txt", alice), "projects tier allowed");

console.log("identity self-test: ok");
