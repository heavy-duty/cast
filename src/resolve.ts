import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Desired } from "./diff.js";
import { type ResolvedEnv, resolveTemplate } from "./envtemplate.js";
import { loadManifest } from "./manifest.js";

export function resolveCheckout(
  orgRepo: string,
  opts: { env: string; path?: string },
): string {
  if (opts.path && opts.env === "prod") {
    throw new Error(
      "apply refuses --path with --env prod: prod always reads the default branch",
    );
  }
  if (opts.path) return opts.path;
  const dir = mkdtempSync(join(tmpdir(), "infra-checkout-"));
  execFileSync(
    "git",
    ["clone", "--depth", "1", `https://github.com/${orgRepo}.git`, dir],
    {
      stdio: "pipe",
    },
  );
  return dir;
}

export function desiredFromManifest(
  checkoutDir: string,
  envName: string,
  secrets: Record<string, string>,
): {
  desired: Desired[];
  resolvedEnvs: Record<string, ResolvedEnv>;
  backupSchedules: Record<string, { frequency: string; retention: number }>;
} {
  const manifest = loadManifest(join(checkoutDir, ".infra", "manifest.yaml"));
  const envSpec = manifest.environments[envName];
  if (!envSpec) {
    throw new Error(
      `environment ${envName} not in manifest (has: ${Object.keys(manifest.environments).join(", ") || "none"})`,
    );
  }
  const desired: Desired[] = [];
  const resolvedEnvs: Record<string, ResolvedEnv> = {};
  const backupSchedules: Record<
    string,
    { frequency: string; retention: number }
  > = {};
  const resolveEnvFile = (
    name: string,
    template?: string,
  ): ResolvedEnv | undefined => {
    if (!template) return undefined;
    const file = join(checkoutDir, ".infra", "env", template);
    if (!existsSync(file))
      throw new Error(`env template missing: ${file} (referenced by ${name})`);
    const env = resolveTemplate(readFileSync(file, "utf8"), secrets);
    resolvedEnvs[name] = env;
    return env;
  };
  for (const [name, app] of Object.entries(envSpec.applications)) {
    desired.push({
      kind: "application",
      name,
      fields: {
        git_repository: app.source.repo,
        git_branch: app.source.branch,
        build_pack: app.build.pack,
        base_directory: app.build.base_directory,
        ...(app.build.publish_directory
          ? { publish_directory: app.build.publish_directory }
          : {}),
        ...(app.build.pack === "dockercompose"
          ? {
              docker_compose_location: app.build.compose_file,
              docker_compose_domains: app.service_domains,
            }
          : {
              ...(app.port !== undefined ? { port: app.port } : {}),
              ...(app.healthcheck ? { healthcheck: app.healthcheck } : {}),
              domains: app.domains,
            }),
      },
      env: resolveEnvFile(name, app.env_template),
    });
  }
  for (const [name, db] of Object.entries(envSpec.databases ?? {})) {
    desired.push({
      kind: "database",
      name,
      fields: { type: db.type, ...(db.version ? { version: db.version } : {}) },
    });
    if (db.backup)
      backupSchedules[name] = {
        frequency: db.backup.frequency,
        retention: db.backup.retention,
      };
  }
  for (const [name, svc] of Object.entries(envSpec.services ?? {})) {
    if (svc.domains && svc.domains.length > 0) {
      // Coolify 4.1.2's service executor has no flat `domains` concept —
      // hostnames live per-container on `urls` (see serviceApiFields in
      // cli.ts) — so a manifest-declared service `domains` list is silently
      // unhonorable by apply. Warn at build time, once per run, while the
      // service name is still in scope.
      console.warn(
        `service ${name} declares domains (${svc.domains.join(", ")}), but apply cannot set them on Coolify 4.1.2 services — configure hostnames manually in the Coolify UI`,
      );
    }
    desired.push({
      kind: "service",
      name,
      // domains dropped from fields, same as database `backup` above: the
      // live side (projectLiveFields in cli.ts) can't read service domains
      // and the write side (serviceApiFields) drops them, so keeping
      // domains in fields makes every domain-bearing service diff as a
      // perpetual update. Hostnames stay a manual Coolify UI act (warned
      // above).
      fields: { type: svc.type },
      env: resolveEnvFile(name, svc.env_template),
    });
  }
  return { desired, resolvedEnvs, backupSchedules };
}
