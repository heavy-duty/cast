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
          s3_destination: z.string().optional(),
          // Var-name patterns this environment refuses outright (see
          // assertEnvVarPolicy). Operator-owned guard: prod typically bans
          // whatever family of flags enables destructive tooling.
          forbidden_var_patterns: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    github_apps: z.record(z.string()),
    smoke_target: z.string().optional(),
  })
  .strict();

export type Bindings = z.infer<typeof BindingsSchema>;

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
