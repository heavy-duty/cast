import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

// The team an environment's token MUST belong to. Give `id` (the true auth
// identity — names can be renamed or duplicated), `name` (human-readable,
// greppable), or both; both are checked when both are given. `cast team`
// prints the current token's id and name so this can be filled in.
const TeamSchema = z
  .object({
    // Non-negative, NOT positive: team **0 is the Root Team** — the one the
    // first user of an instance gets (`if ($user->id === 0) { $team['id'] = 0;
    // $team['name'] = 'Root Team'; }`, app/Models/User.php @ v4.1.2). On a
    // single-admin Coolify that is the team everything lives in, so rejecting
    // 0 would make the id check — the strong half of the assert — unusable on
    // exactly the topology that most needs it.
    id: z.number().int().nonnegative().optional(),
    name: z.string().min(1).optional(),
  })
  .strict()
  .refine((t) => t.id !== undefined || t.name !== undefined, {
    message: "team must give at least one of `id` or `name`",
  });

const BindingsSchema = z
  .object({
    environments: z.record(
      z
        .object({
          server: z.string(),
          // REQUIRED, and deliberately so: this is what makes the team assert
          // fail-closed (see team.ts). An environment with no declared team
          // is an environment cast cannot verify it is pointed at — and an
          // unverifiable target is exactly the silent-duplicate-into-the-
          // wrong-team failure this binding exists to prevent. No team, no
          // apply. Today one state dir holds one token (.coolify.env), so
          // every environment in it normally names the same team; declaring
          // it per environment keeps each one's expectation explicit and
          // survives a future split into per-environment tokens.
          team: TeamSchema,
          // The named Coolify instance this environment lives on
          // (<state>/.coolify/<name>.env). Optional: with no binding and no
          // --instance, cast reads <state>/.coolify.env exactly as it always
          // has. Binding it here is what lets `--env prod` select the right
          // control plane with no flag and no file edit — the connection
          // target stops being implicit in a file's current contents.
          // An explicit --instance still wins, so a one-off read against a
          // legacy box needs no change to this file either.
          instance: z.string().optional(),
          // The age recipient (public key) this environment's secret store is
          // encrypted TO. Only `capture` needs it — decryption resolves an
          // identity per keyFileFor, and the state repo deliberately holds
          // ciphertext but never the identity that opens it. This is the
          // public half, so it is safe to commit here next to the bindings.
          age_recipient: z.string().optional(),
          s3_destination: z.string().optional(),
          // Var-name patterns this environment refuses outright (see
          // assertEnvVarPolicy). Operator-owned guard: prod typically bans
          // whatever family of flags enables destructive tooling.
          forbidden_var_patterns: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    // Keyed by the repo the App clones for. Prefer the FULL `<org>/<repo>`
    // slug; a bare `<repo>` key still resolves (see githubAppNameFor) so
    // existing state files keep working.
    github_apps: z.record(z.string()),
    smoke_target: z.string().optional(),
  })
  .strict();

export type Bindings = z.infer<typeof BindingsSchema>;

// Resolve the Coolify GitHub App name for a repo, full slug first.
//
// The short name alone is not a key: `<repo>` is only unique *within* an org,
// so `heavy-duty/incubator` and `acme/incubator` collapse onto one entry and
// whichever App is bound there gets used to clone BOTH — silently, because a
// wrong-but-existing App resolves to a real uuid and the create succeeds. The
// full slug is the thing that actually identifies a repo, so it wins.
//
// The bare-`<repo>` fallback is kept deliberately: it is what every state file
// written before this used, and dropping it would break them for no gain. A
// short key is unambiguous right up until a second org shows up, which is
// precisely when the full-slug key it falls back from starts winning instead.
export function githubAppNameFor(bindings: Bindings, orgRepo: string): string {
  const repoShort = orgRepo.split("/")[1] ?? orgRepo;
  const name = bindings.github_apps[orgRepo] ?? bindings.github_apps[repoShort];
  if (!name) {
    throw new Error(
      [
        `no GitHub App bound for ${orgRepo}`,
        "",
        `  looked for:  github_apps["${orgRepo}"], then github_apps["${repoShort}"]`,
        `  bound repos: ${Object.keys(bindings.github_apps).join(", ") || "(none)"}`,
        "",
        "Add it to environments.yaml, keyed by the full slug:",
        "",
        "  github_apps:",
        `    ${orgRepo}: <the App's name in Coolify>`,
      ].join("\n"),
    );
  }
  return name;
}

export function loadBindings(
  path: string,
  opts: { overrideText?: string } = {},
): Bindings {
  const text = opts.overrideText ?? readFileSync(path, "utf8");
  const result = BindingsSchema.safeParse(parse(text));
  if (!result.success) {
    throw new Error(`invalid bindings ${path}: ${result.error.message}`);
  }
  return result.data;
}
