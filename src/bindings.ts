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

// State that belongs to ONE project inside ONE environment — not to the
// environment as a whole.
//
// The environment block above it is the wrong scope for any of this, and was
// always going to be: it says `server:`, and a server is exactly the thing two
// projects can share. Everything here is keyed the way `github_apps` is (see
// githubAppNameFor) — by the repo, full `<org>/<repo>` slug first — because the
// repo is what identifies a project to US. The Coolify project NAME is theirs,
// it is what someone typed into a UI, and `--project` exists precisely because
// it does not have to match.
const ProjectBindingSchema = z
  .object({
    // The Docker network this project's resources are created on — a raw UUID,
    // read out of the Coolify UI, exactly like `s3_destination`.
    //
    // A UUID and not a name, deliberately, even though `server:` right above is
    // a name: Coolify 4.1.2 has NO destinations API at all (zero routes in
    // routes/api.php @ v4.1.2), so unlike a server name, cast cannot resolve a
    // destination name to anything. A key called `destination` would invite one.
    // See reference/README.md.
    //
    // Optional, and absent means "whatever the server's only destination is" —
    // which is correct until the server has two, and is why this went unnoticed:
    // Coolify picks `$destinations->first()` when a server has exactly one.
    destination_uuid: z.string().optional(),
    // The app `cast smoke` writes its canary env vars to. Project-scoped
    // because it names one project's application: `core` is incubator's compose
    // app, and the day a second project deploys into this environment, an
    // environment-scoped (let alone the state-file-scoped one it replaces)
    // `smoke_target: core` is simply wrong.
    smoke_target: z.string().optional(),
  })
  .strict();

export type ProjectBinding = z.infer<typeof ProjectBindingSchema>;

// One project in the registry — the top-level `projects:` block, which is the
// list of what EXISTS. Nothing else in this file says that: `environments:`
// says where things are deployed to, `environments.<env>.projects.<repo>` says
// how one project is placed once you already know it is there, and
// `github_apps` says how to clone one you have already named. "Every project"
// was, until this block, a thing the operator remembered.
//
// Two things need the list, and neither can be built without it: fleet
// operations (`cast diff --all`, #26 — iterating "every project in this
// environment") and rebuild-from-state (#27 — a Coolify restored from the state
// repo, which cannot even be attempted without knowing what was on it).
const RegisteredProjectSchema = z
  .object({
    // OUR environment names — the values `--env` takes, the keys of the
    // `environments:` block above — never Coolify's. The distinction is the same
    // one `--env` vs `--environment` draws everywhere else in cast.
    //
    // Non-empty: a project registered into no environment is not a registration,
    // it is a line of YAML that reads like one. It would be skipped by every
    // fleet run silently.
    environments: z.array(z.string().min(1)).nonempty(),
  })
  .strict();

export type RegisteredProject = z.infer<typeof RegisteredProjectSchema>;

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
          // Per-project state, keyed by repo. Optional: an environment whose
          // server hosts one project needs none of it.
          projects: z.record(ProjectBindingSchema).optional(),
        })
        .strict(),
    ),
    // THE REGISTRY: which projects exist at all, keyed by the full `<org>/<repo>`
    // slug. The key IS the repo — there is no `repo:` field inside, because a
    // second place to write the same string is a second place for it to be
    // wrong.
    //
    // Full slug REQUIRED, with no bare-`<repo>` fallback — the one place in this
    // file where that fallback does not exist. `github_apps` and
    // `environments.<env>.projects` carry one because they predate the lesson
    // (#12) and there are state files in the wild keyed the old way; this block
    // is new, has no such files, and so gets to be right from the start. A bare
    // `<repo>` is unique only *within* an org, which is precisely why it is not
    // a key.
    //
    // Optional: a state file written before the registry existed keeps loading
    // untouched, and `projectsIn` answers `[]` for it.
    projects: z.record(RegisteredProjectSchema).optional(),
    // Keyed by the repo the App clones for. Prefer the FULL `<org>/<repo>`
    // slug; a bare `<repo>` key still resolves (see githubAppNameFor) so
    // existing state files keep working.
    github_apps: z.record(z.string()),
    // DEPRECATED — moved to environments.<env>.projects.<repo>.smoke_target.
    // Still read (see smokeTargetFor) so state files written before the move
    // keep working, on the same reasoning as the bare-`<repo>` github_apps key.
    // It is wrong at TWO levels: it names one project's app (`core`) from a key
    // scoped to the whole state file, so it cannot distinguish two projects and
    // cannot distinguish prod's app from staging's either.
    smoke_target: z.string().optional(),
  })
  .strict()
  // The registry only earns its keep if it is TRUE. Every check here defends the
  // same failure: a project that a fleet run never visits, because a fleet run
  // that skips a project prints exactly what a fleet run over a clean project
  // prints — nothing. Silence is the one report that must never be ambiguous, so
  // these are parse-time errors (every verb loads bindings, so every verb refuses
  // a registry that lies) rather than warnings some command might print.
  .superRefine((bindings, ctx) => {
    const registry = bindings.projects;
    if (!registry) return;

    const knownEnvs = Object.keys(bindings.environments);
    const knownEnvList = knownEnvs.join(", ") || "(none)";

    for (const [slug, project] of Object.entries(registry)) {
      // A key with no `/` is not a repo. See the schema note above: no fallback.
      if (!slug.includes("/")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["projects", slug],
          message: [
            `projects["${slug}"] is not a repo — a registry key has no meaning without its org`,
            "",
            `  found:     projects["${slug}"]`,
            "  wanted:    a full <org>/<repo> slug",
            "",
            "A bare <repo> is unique only *within* an org: heavy-duty/incubator and",
            "acme/incubator collapse onto one entry, and the registry then claims one",
            "project where there are two. Unlike github_apps, this block is new and has",
            "no legacy state files to support, so there is no bare-<repo> fallback.",
            "",
            "  projects:",
            `    <org>/${slug}:`,
            `      environments: [${project.environments.join(", ")}]`,
          ].join("\n"),
        });
      }

      // Every environment named here must be one that actually exists. A typo
      // makes the project real but its environment imaginary — so `--all` visits
      // nothing for it, reports nothing about it, and exits clean.
      for (const envName of project.environments) {
        if (!(envName in bindings.environments)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["projects", slug, "environments"],
            message: [
              `projects["${slug}"] is registered in environment "${envName}", which does not exist`,
              "",
              `  registered:  projects["${slug}"].environments  →  ${project.environments.join(", ")}`,
              `  known envs:  ${knownEnvList}`,
              "",
              "An environment nothing defines is one that no command can visit: a fleet",
              "run would skip this project, and a silently skipped project reads exactly",
              "like a clean one. Fix the name, or declare the environment:",
              "",
              "  environments:",
              `    ${envName}:`,
              "      server: <server>",
              "      team: { id: <id>, name: <name> }",
            ].join("\n"),
          });
        }
      }
    }

    // The other direction, and the one that rots quietly: a project carrying
    // per-environment state (destination_uuid, smoke_target — #21) in an
    // environment the registry does not register it for. That state is then real
    // enough to be used by a direct `cast apply <repo> --env <env>` and invisible
    // to every fleet run — the two blocks describing two different fleets.
    //
    // Only checked when `projects:` is present, so state files written before the
    // registry keep loading exactly as they did.
    for (const [envName, env] of Object.entries(bindings.environments)) {
      for (const key of Object.keys(env.projects ?? {})) {
        const entry = registry[key];
        if (entry?.environments.includes(envName)) continue;

        // The likeliest cause, worth saying out loud: a legacy bare-<repo> key
        // (which projectBindingFor still resolves) under a registry that is
        // correctly keyed by slug. The fix is a rename, not a registration.
        const slugFor = key.includes("/")
          ? undefined
          : Object.keys(registry).find((s) => s.endsWith(`/${key}`));

        const cause = slugFor
          ? [
              `  registry has:  projects["${slugFor}"]`,
              "",
              "The binding uses the legacy bare-<repo> key. The registry is keyed by the",
              `full slug, so rename it to match — environments.${envName}.projects["${slugFor}"].`,
            ]
          : entry
            ? [
                `  registered for:  ${entry.environments.join(", ")}`,
                "",
                "Register the project in this environment, or drop the binding — state that",
                "no fleet run will ever visit is state that stops being true without anyone",
                "finding out:",
                "",
                "  projects:",
                `    ${key}:`,
                `      environments: [${[...entry.environments, envName].join(", ")}]`,
              ]
            : [
                `  registry has:  ${Object.keys(registry).join(", ") || "(nothing)"}`,
                "",
                "The project is not in the registry at all, so no fleet run will ever visit",
                "it — while this binding says it is deployed here. Register it, or drop the",
                "binding:",
                "",
                "  projects:",
                `    ${key}:`,
                `      environments: [${envName}]`,
              ];

        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["environments", envName, "projects", key],
          message: [
            `environments.${envName}.projects["${key}"] is bound in an environment the registry does not register it for`,
            "",
            `  bound at:      environments.${envName}.projects["${key}"]`,
            ...cause,
          ].join("\n"),
        });
      }
    }
  });

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

// The project-scoped bindings for one repo in one environment, or undefined if
// the environment declares none. Same full-slug-then-bare-repo lookup as
// githubAppNameFor, for the same reason — see the note there.
//
// Absence is NOT an error: `projects:` is optional, and an environment with a
// single project on a single-destination server has nothing to say here. The
// callers that genuinely need a value (smoke) say so themselves.
export function projectBindingFor(
  bindings: Bindings,
  envName: string,
  orgRepo: string,
): ProjectBinding | undefined {
  const projects = bindings.environments[envName]?.projects;
  if (!projects) return undefined;
  const repoShort = orgRepo.split("/")[1] ?? orgRepo;
  return projects[orgRepo] ?? projects[repoShort];
}

// The app `cast smoke` targets. Project-scoped first; the deprecated
// state-file-scoped `smoke_target` is the fallback, so an unmigrated state file
// still smokes.
//
// `orgRepo` is optional because `cast smoke` did not take one until the target
// became project-scoped — without it there is no project to look up and only
// the old key can answer, which is exactly what the old invocation did.
export function smokeTargetFor(
  bindings: Bindings,
  envName: string,
  orgRepo?: string,
): { target: string; source: "project" | "deprecated" } | undefined {
  const scoped = orgRepo
    ? projectBindingFor(bindings, envName, orgRepo)?.smoke_target
    : undefined;
  if (scoped) return { target: scoped, source: "project" };
  if (bindings.smoke_target)
    return { target: bindings.smoke_target, source: "deprecated" };
  return undefined;
}

// The `<org>/<repo>` slugs registered for one environment — the list a fleet
// operation iterates (`cast diff --all`, #26) and a rebuild reads (#27).
//
// SORTED, deliberately: the order of keys in a YAML file is an accident of who
// typed what when, and a fleet run's output — which a human reads top to bottom,
// and CI diffs — must not reshuffle because someone appended a project. The
// registry is a set; this returns it as one.
//
// `[]` when there is no registry, which is every state file written before this
// block existed. That is the honest answer for "which projects are registered
// here" when nothing is registered anywhere — and it makes a fleet verb over an
// unmigrated state file a clean no-op rather than a crash.
export function projectsIn(bindings: Bindings, envName: string): string[] {
  const registry = bindings.projects;
  if (!registry) return [];
  return Object.entries(registry)
    .filter(([, project]) => project.environments.includes(envName))
    .map(([slug]) => slug)
    .sort();
}

export function loadBindings(
  path: string,
  opts: { overrideText?: string } = {},
): Bindings {
  const text = opts.overrideText ?? readFileSync(path, "utf8");
  const result = BindingsSchema.safeParse(parse(text));
  if (!result.success) {
    // Zod's own `.message` is the entire issue array as JSON — which renders the
    // refusals above as one long line of `\n` escapes, i.e. throws away the part
    // of them that was worth writing. Render the issues instead.
    const detail = result.error.issues
      .map((issue) => {
        // A multi-line message is one WE wrote: it already names the path, the
        // cause, and the YAML to write. A one-line message is zod's ("Required"),
        // and is useless without the path it happened at.
        if (issue.message.includes("\n")) return issue.message;
        const where = issue.path.map(String).join(".");
        return where ? `${where}: ${issue.message}` : issue.message;
      })
      .join("\n\n");
    throw new Error(`invalid bindings ${path}:\n\n${detail}`);
  }
  return result.data;
}
