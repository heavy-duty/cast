import type { CoolifyClient, Team } from "./coolify.js";

// What environments.yaml declares a token must be, for a given environment.
// At least one of id/name is present (enforced by the bindings schema); both
// are compared when both are given.
export type TeamExpectation = { id?: number; name?: string };

export function formatTeam(t: TeamExpectation | Team): string {
  const parts: string[] = [];
  if (t.id !== undefined) parts.push(`id=${t.id}`);
  if (t.name !== undefined) parts.push(`name=${JSON.stringify(t.name)}`);
  return parts.join(" ");
}

// The fail-closed pre-flight gate. Every command that reaches a live Coolify
// runs this BEFORE its first read, and never mutates without it.
//
// Why this has to exist at all: Coolify API tokens are team-scoped
// (User::createToken stamps `team_id` onto the token), and a token used
// against another team's resources does not error — the API resolves through
// `getResourceByUuid($uuid, getTeamIdFromToken())`, which simply returns
// `null` on a team mismatch. To cast, `null` is indistinguishable from "this
// resource does not exist yet", which is an invitation to CREATE it. So a
// wrong-team token would not fail an apply; it would silently provision a
// duplicate set of resources into the wrong team, against whatever server
// that team owns. Silent, mutating, and discovered late — the worst shape of
// failure there is.
//
// Nothing below the team scopes a token: an Environment has no `team_id` of
// its own (it hangs off a project), and no API path scopes by environment.
// Coolify environments are an organizational construct, not an auth boundary.
// The team is the only boundary there is, so it is the one thing we assert.
export async function assertTeam(
  client: CoolifyClient,
  expected: TeamExpectation,
  envName: string,
): Promise<Team> {
  // An expectation naming neither id nor name would compare nothing and pass
  // against any team alive — the gate would fail OPEN. The bindings schema
  // already rejects that shape, but this is the one function whose entire job
  // is to fail closed, and it must not depend on a `.refine()` in another file
  // to do it. Cheap, and it means no future caller can quietly defeat it.
  if (expected.id === undefined && expected.name === undefined) {
    throw new Error(
      `cannot verify the token's team for environment ${envName}: its \`team:\` binding names neither an id nor a name`,
    );
  }
  const actual = await client.currentTeam();
  const mismatched: string[] = [];
  if (expected.id !== undefined && expected.id !== actual.id) {
    mismatched.push("id");
  }
  if (expected.name !== undefined && expected.name !== actual.name) {
    mismatched.push("name");
  }
  if (mismatched.length === 0) return actual;
  throw new Error(
    [
      "refusing to touch Coolify: this token belongs to the wrong team",
      "",
      `  environment:   ${envName}`,
      `  expected team: ${formatTeam(expected)}  (environments.yaml)`,
      `  token's team:  ${formatTeam(actual)}  (GET /teams/current)`,
      `  mismatched:    ${mismatched.join(", ")}`,
      "",
      "Coolify tokens are team-scoped, and a wrong-team token does NOT fail —",
      "it resolves every resource it cannot see to null. cast would read that",
      'as "does not exist yet" and create a DUPLICATE set of resources in the',
      "wrong team, on whatever server that team owns.",
      "",
      "Fix the token (mint one from the expected team in Coolify → Keys &",
      "Tokens) or fix the environment's `team:` binding — whichever is wrong.",
      "`cast team` prints the team the current token acts as.",
    ].join("\n"),
  );
}
