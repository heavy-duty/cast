import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

// Coolify validates every checkout-relative path on create and 422s anything
// that is not absolute. Transcribed from coolify v4.1.2:
// `bootstrap/helpers/api.php::sharedDataApplications()` binds
// `base_directory`/`publish_directory` to `ValidationPatterns::directoryPathRules()`
// and `docker_compose_location` to `ValidationPatterns::filePathRules()`, and
// `app/Support/ValidationPatterns.php` defines the two patterns below. The only
// difference between them: a file path needs at least one character after the
// slash, a directory path may be the bare `/` (the checkout root).
const COOLIFY_FILE_PATH = /^\/[a-zA-Z0-9._/~@+-]+$/;
const COOLIFY_DIRECTORY_PATH = /^\/[a-zA-Z0-9._/~@+-]*$/;

// These are refinements, not normalizations, and must stay that way: cast does
// not quietly rewrite what the manifest says. A value that would 422 gets fixed
// in the file, in a commit, once — not repaired in memory on every run. And the
// check belongs here, at parse time, because it is a property of the manifest
// and of nothing else: by the time a create returns its bare 422, `apply` has
// already made the project and the environment, and the run is half-applied.
const composeFilePath = z
  .string()
  .regex(
    COOLIFY_FILE_PATH,
    "compose_file must be an absolute path inside the repo checkout (Coolify 4.1.2 rejects the create otherwise) — write /docker-compose.yaml, not docker-compose.yaml",
  );

const repoDirectoryPath = (field: string) =>
  z
    .string()
    .regex(
      COOLIFY_DIRECTORY_PATH,
      `${field} must be an absolute path inside the repo checkout (Coolify 4.1.2 rejects the create otherwise) — write /apps/core, not apps/core; the checkout root is /`,
    );

// A store REF — `${NAME}` and nothing else. The one syntax cast already uses for
// a secret, in env templates (envtemplate.ts), reused verbatim rather than
// invented a second time: the value lives in the environment's age store, keyed
// by NAME, and the manifest carries only the name.
//
// This is a REFUSAL, not a preference. `http_basic_auth_password` is the first
// secret cast writes that is a resource FIELD rather than an env var, and a
// manifest is a reviewed, committed artifact — a literal here is a password in
// git, permanently, in the file everyone reads to understand the system. There is
// no ergonomic case that outweighs that, so the schema makes the mistake
// unrepresentable rather than warning about it.
const STORE_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

// HTTP Basic Auth on an application, as Coolify 4.1.2 can actually set it:
// `is_http_basic_auth_enabled`, `http_basic_auth_username` and
// `http_basic_auth_password` are in the create allowlist
// (`ApplicationsController.php:914`) and the PATCH allowlist (`:2368`), and PATCH
// enforces username/password presence when enabling (`:2446-2463`).
//
// `enabled` is explicit rather than inferred from the block's presence, because
// the two halves of the vocabulary are not symmetric: `enabled: true` needs
// credentials, `enabled: false` must have none (a password ref standing over a
// disabled auth is dead config that reads like a guard). Spelling it out is also
// what lets the presence rule below fail with a message about the field the
// operator got wrong, instead of a union mismatch about two shapes.
//
// OMITTING the block leaves basic auth alone entirely — the `is_static` rule
// (see resolve.ts), for the same reason: emitting `is_http_basic_auth_enabled:
// false` on every application would make the first apply after this ships strip
// basic auth off every app protected by hand in the UI whose manifest has not yet
// been migrated. Protection removed, silently, by an upgrade. So: declare
// `enabled: true` to protect, `enabled: false` to actively assert it is off, omit
// to say nothing.
const BasicAuthSchema = z
  .object({
    enabled: z.boolean(),
    username: z.string().optional(),
    password: z
      .string()
      .regex(
        STORE_REF,
        "basic_auth.password must be a store ref (${NAME}) whose value lives in the environment's age store — never a literal, which would be a password committed to git",
      )
      .optional(),
  })
  .strict()
  .superRefine((auth, ctx) => {
    // Coolify's own rule, enforced HERE so it fails in the file rather than as a
    // bare 422 from a PATCH that has already half-applied a run
    // (ApplicationsController.php:2446-2463 @ v4.1.2 requires both when
    // enabling). Same reasoning as the checkout-path patterns above.
    if (auth.enabled) {
      for (const k of ["username", "password"] as const)
        if (auth[k] === undefined || auth[k] === "")
          ctx.addIssue({
            code: "custom",
            message: `basic_auth.${k} is required when basic_auth.enabled is true (Coolify rejects the write otherwise, and half-protected basic auth protects nothing)`,
          });
    } else {
      for (const k of ["username", "password"] as const)
        if (auth[k] !== undefined)
          ctx.addIssue({
            code: "custom",
            message: `basic_auth.${k} is not allowed when basic_auth.enabled is false — a credential declared for a disabled auth is dead config that reads like a guard`,
          });
    }
  });

const AppSpecSchema = z
  .object({
    source: z.object({ repo: z.string(), branch: z.string() }).strict(),
    build: z
      .object({
        pack: z.enum(["nixpacks", "static", "dockerfile", "dockercompose"]),
        base_directory: repoDirectoryPath("base_directory"),
        publish_directory: repoDirectoryPath("publish_directory").optional(),
        compose_file: composeFilePath.optional(),
        // The three build/run commands and the static flag Coolify accepts on
        // both the create (POST /applications/private-github-app) and the
        // update (PATCH /applications/{uuid}) routes. They are free-form
        // strings passed through verbatim — cast does not parse or validate the
        // shell in them, only whether they belong on this pack (superRefine
        // below). `static` maps to Coolify's `is_static`: it makes Coolify
        // SERVE `publish_directory` and run NO start command, which is exactly
        // the fix for a static site in a workspace monorepo that otherwise gets
        // built and RUN from the repo-root package.json (#63).
        install_command: z.string().optional(),
        build_command: z.string().optional(),
        start_command: z.string().optional(),
        static: z.boolean().optional(),
      })
      .strict(),
    port: z.number().int().optional(),
    healthcheck: z.string().optional(),
    domains: z.array(z.string()).optional(),
    service_domains: z.record(z.array(z.string())).optional(),
    basic_auth: BasicAuthSchema.optional(),
    env_template: z.string().optional(),
  })
  .strict()
  .superRefine((app, ctx) => {
    if (app.build.pack === "dockercompose") {
      if (!app.build.compose_file)
        ctx.addIssue({
          code: "custom",
          message: "dockercompose apps require build.compose_file",
        });
      if (!app.service_domains)
        ctx.addIssue({
          code: "custom",
          message: "dockercompose apps require service_domains",
        });
      for (const k of ["port", "healthcheck", "domains"] as const)
        if (app[k] !== undefined)
          ctx.addIssue({
            code: "custom",
            message: `${k} not allowed on a dockercompose app (lives in the compose file)`,
          });
      if (app.build.publish_directory)
        ctx.addIssue({
          code: "custom",
          message: "publish_directory not allowed on a dockercompose app",
        });
      // A compose app builds and runs from its compose file — Coolify never
      // consults these on it. Reject them at parse time rather than post them
      // and have them silently ignored (the same reasoning as publish_directory
      // and port above).
      for (const k of [
        "install_command",
        "build_command",
        "start_command",
      ] as const)
        if (app.build[k] !== undefined)
          ctx.addIssue({
            code: "custom",
            message: `build.${k} not allowed on a dockercompose app (it builds from its compose file)`,
          });
      if (app.build.static !== undefined)
        ctx.addIssue({
          code: "custom",
          message:
            "build.static not allowed on a dockercompose app (a compose file decides what is served)",
        });
    } else {
      if (!app.domains)
        ctx.addIssue({
          code: "custom",
          message: "domains required (non-compose app)",
        });
      if (app.service_domains || app.build.compose_file)
        ctx.addIssue({
          code: "custom",
          message:
            "service_domains/compose_file only allowed with pack dockercompose",
        });
      // `static: true` tells Coolify to serve publish_directory and run no
      // start command — so a static app with nothing to serve is almost
      // certainly a mistake, and one that would deploy green while serving an
      // empty site. Catch it in the file, once, not on a live box.
      if (app.build.static === true && !app.build.publish_directory)
        ctx.addIssue({
          code: "custom",
          message:
            "build.static: true serves publish_directory and runs no start command — but no publish_directory is set, so there is nothing to serve",
        });
    }
  });

const DatabaseSpecSchema = z
  .object({
    type: z.enum(["postgresql", "redis"]),
    version: z.string().optional(),
    backup: z
      .object({ frequency: z.string(), retention: z.number().int() })
      .strict()
      .optional(),
  })
  .strict();

const ServiceSpecSchema = z
  .object({
    type: z.string(),
    // Per-container hostnames, exactly the vocabulary a dockercompose app uses
    // (a map of container name -> URLs). A Coolify service is a bundle of
    // containers (`ServiceApplication`s), and a hostname is set on ONE of them —
    // so a flat `domains: string[]` cannot say which, and cannot build the
    // `urls: [{name, url}]` payload the API matches to a container by name
    // (cast#72, verified against ServicesController@applyServiceUrls v4.1.2).
    // The name is the container's, discoverable from a `cast diff` read-back or
    // the Coolify UI. Written on create/PATCH, read back off
    // `service.applications[].fqdn`, and diffed like any other field.
    service_domains: z.record(z.array(z.string())).optional(),
    env_template: z.string().optional(),
  })
  .strict();

const EnvironmentSpecSchema = z
  .object({
    applications: z.record(AppSpecSchema),
    databases: z.record(DatabaseSpecSchema).optional(),
    services: z.record(ServiceSpecSchema).optional(),
    // Secret names whose values the PROVIDER generates — a Coolify-created
    // Postgres/Redis URL, a service's own generated credentials. `capture`
    // writes these as the literal `pending-coolify-generated` and never copies
    // the source box's live value: that value points at the SOURCE box's
    // database, so carrying it over would be confidently wrong in a way that
    // looks entirely plausible, and the target's real URL does not exist until
    // Coolify creates the resource.
    //
    // It is a manifest property rather than a flag the operator has to
    // remember, because the manifest is what knows DATABASE_URL comes from a
    // database it declares. Optional: a manifest that names none simply has no
    // generated secrets, and `capture` will say so in its plan.
    generated_secrets: z.array(z.string()).optional(),
  })
  .strict();

const ManifestSchema = z
  .object({
    project: z.string(),
    environments: z.record(EnvironmentSpecSchema),
  })
  .strict();

// The NAME inside a `${NAME}` store ref, or undefined if this is not one. The
// single reader of STORE_REF outside the schema, so the syntax the manifest
// ACCEPTS and the syntax resolution UNDERSTANDS cannot drift apart.
export function storeRefName(value: string): string | undefined {
  return STORE_REF.exec(value)?.[1];
}

export type AppSpec = z.infer<typeof AppSpecSchema>;
export type DatabaseSpec = z.infer<typeof DatabaseSpecSchema>;
export type ServiceSpec = z.infer<typeof ServiceSpecSchema>;
export type EnvironmentSpec = z.infer<typeof EnvironmentSpecSchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export function loadManifest(
  path: string,
  opts: { overrideText?: string } = {},
): Manifest {
  const text = opts.overrideText ?? readFileSync(path, "utf8");
  const result = ManifestSchema.safeParse(parse(text));
  if (!result.success) {
    throw new Error(
      `invalid manifest ${path}: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return result.data;
}
