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

const AppSpecSchema = z
  .object({
    source: z.object({ repo: z.string(), branch: z.string() }).strict(),
    build: z
      .object({
        pack: z.enum(["nixpacks", "static", "dockerfile", "dockercompose"]),
        base_directory: repoDirectoryPath("base_directory"),
        publish_directory: repoDirectoryPath("publish_directory").optional(),
        compose_file: composeFilePath.optional(),
      })
      .strict(),
    port: z.number().int().optional(),
    healthcheck: z.string().optional(),
    domains: z.array(z.string()).optional(),
    service_domains: z.record(z.array(z.string())).optional(),
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
    domains: z.array(z.string()).optional(),
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
