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

// A registry image reference, for the `dockerimage` pack (cast#161). The name
// is the repository without a tag (`ghcr.io/acme/widget`), the tag a plain tag
// or Coolify's digest spelling (`sha256-<hex>`). Coolify 4.1.2 normalises the
// pair itself on create (DockerImageParser, ApplicationsController.php:1822-
// 1839), so a name carrying a `:tag` would be split and stored differently from
// what the manifest says, and diff forever. Refused at parse time instead.
const ImageSchema = z
  .object({
    name: z
      .string()
      .regex(
        /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:(?::[0-9]+)?\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/,
        "image.name is the repository only — ghcr.io/acme/widget — with the tag under image.tag (Coolify splits a name:tag itself and the manifest would never match what it stored)",
      ),
    tag: z
      .string()
      .regex(
        /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/,
        "image.tag must be a docker tag (letters, digits, _ . -; up to 128 characters), or Coolify's sha256-<digest> spelling",
      ),
  })
  .strict();

// A persistent volume on a non-compose application (cast#167): Coolify's
// `LocalPersistentVolume`, written through POST /applications/{uuid}/storages.
// Three rules come straight from Coolify 4.1.2 (ApplicationsController.php
// create_storage / update_storage, ValidationPatterns.php), refused here at
// parse time rather than as a 422 half-way through an apply:
//
//   - `name` matches VOLUME_NAME_PATTERN, `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`.
//     Coolify stores the volume as `<application uuid>-<name>` — so the name
//     a manifest declares is bound to the RESOURCE, and recreating the
//     resource is a data migration, never an apply.
//   - `host_path`, when given, matches DIRECTORY_PATH_PATTERN (an absolute
//     path); omitted, the volume is a Docker named volume.
//   - `mount_path` is where the container sees it. Coolify does not validate
//     it on this route, so cast holds it to an absolute path: a relative mount
//     is a volume mounted somewhere nobody meant.
//
// Only `persistent` storages. A `file` storage (a file or directory written
// from the host) is the same route with a different shape; it is out of scope,
// and `draft` names any it finds as not expressible.
const COOLIFY_VOLUME_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const StorageSchema = z
  .object({
    name: z
      .string()
      .regex(
        COOLIFY_VOLUME_NAME,
        "storages[].name must start with a letter or digit and hold only letters, digits, '.', '_' or '-' (Coolify's volume-name rule; it stores the volume as <application uuid>-<name>)",
      ),
    mount_path: z
      .string()
      .regex(
        /^\/[a-zA-Z0-9._/~@+-]+$/,
        "storages[].mount_path must be an absolute path inside the container, such as /data",
      ),
    host_path: z
      .string()
      .regex(
        COOLIFY_DIRECTORY_PATH,
        "storages[].host_path must be an absolute path on the server (Coolify 4.1.2 rejects the write otherwise); omit it for a Docker named volume",
      )
      .optional(),
  })
  .strict();

// A network alias (cast#170): a DNS label a container answers on. Coolify
// 4.1.2 validates `custom_network_aliases` only as a string, splits it on
// commas, and rewrites a space to `-` (Application::customNetworkAliases), so
// cast holds each entry to the shape that survives that round trip unchanged.
const NETWORK_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// The packs Coolify clones a git source for. `dockerimage` is the one that does
// not: its application is created from a registry image, through a different
// route (POST /applications/dockerimage), and carries no `source`.
const GIT_PACKS = [
  "nixpacks",
  "static",
  "dockerfile",
  "dockercompose",
] as const;

const AppSpecSchema = z
  .object({
    // Optional in the SHAPE only for the dockerimage pack — every git-sourced
    // pack still requires it, through the superRefine below, so no existing
    // manifest changes.
    source: z
      .object({ repo: z.string(), branch: z.string() })
      .strict()
      .optional(),
    image: ImageSchema.optional(),
    build: z
      .object({
        pack: z.enum([...GIT_PACKS, "dockerimage"]),
        // Same story as `source`: a checkout path is meaningless without a
        // checkout, so the dockerimage pack refuses it and every other pack
        // requires it (superRefine).
        base_directory: repoDirectoryPath("base_directory").optional(),
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
    // Persistent volumes on a non-compose application (cast#167). A compose
    // application's volumes are its compose file's, and are refused here.
    storages: z.array(StorageSchema).optional(),
    // Network aliases on a non-compose application (cast#170): the names
    // another resource on the destination network reaches it by, Coolify's
    // `custom_network_aliases`. A compose application's aliases are its
    // compose file's, and are refused here.
    network_aliases: z
      .array(
        z
          .string()
          .regex(
            NETWORK_ALIAS,
            "network_aliases[] must start with a letter or digit and hold only letters, digits, '.', '_' or '-' — Coolify splits the list on commas and rewrites a space to '-'",
          ),
      )
      .optional(),
    env_template: z.string().optional(),
  })
  .strict()
  .superRefine((app, ctx) => {
    if (app.network_aliases) {
      const seen = new Set<string>();
      for (const alias of app.network_aliases) {
        if (seen.has(alias))
          ctx.addIssue({
            code: "custom",
            message: `network_aliases: ${alias} is listed twice (Coolify keeps one)`,
          });
        seen.add(alias);
      }
      if (app.build.pack === "dockercompose")
        ctx.addIssue({
          code: "custom",
          message:
            "network_aliases not allowed on a dockercompose app (a compose service's aliases live in the compose file, under its networks)",
        });
    }
    // A volume is matched by its name and mounted at one path: two entries
    // sharing either would be two claims on one thing, and apply could only
    // honour one of them.
    if (app.storages) {
      for (const k of ["name", "mount_path"] as const) {
        const seen = new Set<string>();
        for (const st of app.storages) {
          if (seen.has(st[k]))
            ctx.addIssue({
              code: "custom",
              message: `storages: two entries share ${k} ${st[k]} (a storage is matched by name and mounted at one path)`,
            });
          seen.add(st[k]);
        }
      }
      if (app.build.pack === "dockercompose")
        ctx.addIssue({
          code: "custom",
          message:
            "storages not allowed on a dockercompose app (its volumes live in the compose file, under the service that mounts them)",
        });
    }
    // The dockerimage pack (cast#161): an application deployed from a registry
    // image, with no git source and nothing Coolify could build. Everything
    // that describes a checkout or a build is refused in the same shape as the
    // dockercompose refusals below, so a reader learns the rule from either
    // message; what routes traffic (`domains`, `port`) is required, because a
    // Docker Image resource without a port has nothing for the proxy to reach,
    // and Coolify's rolling update needs a port to health-check.
    if (app.build.pack === "dockerimage") {
      if (!app.image)
        ctx.addIssue({
          code: "custom",
          message:
            "dockerimage apps require image: { name, tag } (the registry image Coolify pulls; there is no git source to build from)",
        });
      if (app.source !== undefined)
        ctx.addIssue({
          code: "custom",
          message:
            "source not allowed on a dockerimage app (it is pulled from a registry, not cloned; the image is image: { name, tag })",
        });
      for (const k of [
        "base_directory",
        "publish_directory",
        "compose_file",
        "install_command",
        "build_command",
        "start_command",
        "static",
      ] as const)
        if (app.build[k] !== undefined)
          ctx.addIssue({
            code: "custom",
            message: `build.${k} not allowed on a dockerimage app (nothing is checked out or built; the image is pulled as-is)`,
          });
      if (app.service_domains !== undefined)
        ctx.addIssue({
          code: "custom",
          message:
            "service_domains only allowed with pack dockercompose (a dockerimage app is one container; use domains)",
        });
      if (!app.domains)
        ctx.addIssue({
          code: "custom",
          message: "domains required (dockerimage app)",
        });
      if (app.port === undefined)
        ctx.addIssue({
          code: "custom",
          message:
            "port required on a dockerimage app (Coolify's proxy and health check need the port the container serves)",
        });
      return;
    }
    // Every git-sourced pack: the source and the checkout root are required, and
    // an image block names a registry image Coolify would never pull.
    if (app.source === undefined)
      ctx.addIssue({
        code: "custom",
        message: `source required (a ${app.build.pack} app is cloned from source: { repo, branch })`,
      });
    if (app.build.base_directory === undefined)
      ctx.addIssue({
        code: "custom",
        message: "build.base_directory required (the checkout root is /)",
      });
    if (app.image !== undefined)
      ctx.addIssue({
        code: "custom",
        message: `image only allowed with pack dockerimage (a ${app.build.pack} app builds from its source)`,
      });
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
