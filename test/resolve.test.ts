import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeDiff } from "../src/diff.js";
import {
  cloneFailureMessage,
  desiredFromManifest,
  resolveCheckout,
  resolveGitAuth,
} from "../src/resolve.js";

describe("resolveCheckout", () => {
  it("hard-refuses --path with prod", () => {
    expect(() =>
      resolveCheckout("acme/widget", { env: "prod", path: "/tmp/x" }),
    ).toThrow(/--path.*prod/);
  });
  it("returns --path for non-prod", () => {
    expect(
      resolveCheckout("acme/widget", {
        env: "staging",
        path: "/tmp/x",
      }),
    ).toBe("/tmp/x");
  });
});

describe("resolveGitAuth", () => {
  const noGh = () => false;
  const yesGh = () => true;

  it("prefers gh, borrowed as a per-invocation credential helper", () => {
    const auth = resolveGitAuth({ GITHUB_TOKEN: "t" }, yesGh);
    expect(auth.source).toBe("gh");
    expect(auth.configArgs.join(" ")).toContain("!gh auth git-credential");
    // No token is materialized when gh is driving.
    expect(auth.env).toEqual({});
  });

  it("falls back to GITHUB_TOKEN when gh is absent", () => {
    const auth = resolveGitAuth({ GITHUB_TOKEN: "ghp_secret" }, noGh);
    expect(auth.source).toBe("token");
    expect(auth.env).toEqual({ CAST_GIT_TOKEN: "ghp_secret" });
  });

  it("accepts GH_TOKEN as well as GITHUB_TOKEN", () => {
    const auth = resolveGitAuth({ GH_TOKEN: "ghp_secret" }, noGh);
    expect(auth.source).toBe("token");
    expect(auth.env).toEqual({ CAST_GIT_TOKEN: "ghp_secret" });
  });

  // The acceptance criterion from #13: "the token never appears in process
  // arguments or on disk". The helper string git receives must carry the
  // NAME of the variable, never its value — sh expands it inside the helper.
  it("never puts the token value in the git argv", () => {
    const auth = resolveGitAuth({ GITHUB_TOKEN: "ghp_secret" }, noGh);
    const argv = auth.configArgs.join(" ");
    expect(argv).not.toContain("ghp_secret");
    expect(argv).toContain("$CAST_GIT_TOKEN");
  });

  // A helper configured globally would otherwise be consulted first and
  // silently decide the outcome, defeating the order cast just established.
  it("resets the inherited helper list before installing its own", () => {
    for (const auth of [
      resolveGitAuth({}, yesGh),
      resolveGitAuth({ GITHUB_TOKEN: "t" }, noGh),
    ]) {
      expect(auth.configArgs.slice(0, 2)).toEqual(["-c", "credential.helper="]);
    }
  });

  it("falls through to the ambient helper when there is nothing else", () => {
    expect(resolveGitAuth({}, noGh)).toEqual({
      source: "ambient",
      configArgs: [],
      env: {},
    });
  });
});

describe("cloneFailureMessage", () => {
  const ambient = { source: "ambient" as const, configArgs: [], env: {} };
  const gh = { source: "gh" as const, configArgs: [], env: {} };

  // The original bug: git's own error talked about THE REPOSITORY when the
  // real fault was cast having no credentials at all.
  it("blames the missing credentials, not the repo, when there were none", () => {
    const msg = cloneFailureMessage("heavy-duty/incubator", ambient, "");
    expect(msg).toMatch(/no GitHub credentials/);
    expect(msg).toMatch(/gh auth login/);
    expect(msg).toMatch(/GITHUB_TOKEN/);
    expect(msg).not.toMatch(/does not exist/);
  });

  // ...and the converse: once cast DID authenticate, the repo really is a
  // candidate explanation again, and 404-means-403 has to be spelled out.
  it("names both roads when a credential was used and GitHub still refused", () => {
    const msg = cloneFailureMessage("heavy-duty/incubator", gh, "");
    expect(msg).toMatch(/gh/);
    expect(msg).toMatch(/does not exist/);
    expect(msg).toMatch(/private/);
    expect(msg).not.toMatch(/no GitHub credentials/);
  });

  it("passes git's own stderr through rather than swallowing it", () => {
    const msg = cloneFailureMessage(
      "heavy-duty/incubator",
      ambient,
      "fatal: could not read Username for 'https://github.com'",
    );
    expect(msg).toMatch(/could not read Username/);
  });
});

describe("desiredFromManifest", () => {
  it("maps manifest + templates to Desired[] with resolved env", () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra", "env"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  staging:
    applications:
      core-api:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: /apps/core }
        port: 3000
        healthcheck: /health
        domains: ["http://api.staging.example.com"]
        env_template: core-api.staging.env.template
`,
    );
    writeFileSync(
      join(dir, ".infra", "env", "core-api.staging.env.template"),
      "PORT=3000\nMG=${MG}\n",
    );
    const { desired, resolvedEnvs, backupSchedules } = desiredFromManifest(
      dir,
      "staging",
      {
        MG: "secret-v",
      },
    );
    expect(desired).toHaveLength(1);
    expect(desired[0]).toMatchObject({
      kind: "application",
      name: "core-api",
      fields: {
        git_repository: "acme/widget",
        git_branch: "main",
        build_pack: "nixpacks",
        base_directory: "/apps/core",
        port: 3000,
        healthcheck: "/health",
        domains: ["http://api.staging.example.com"],
      },
    });
    expect(resolvedEnvs["core-api"].vars.MG).toEqual({
      value: "secret-v",
      secret: true,
    });
    expect(backupSchedules).toEqual({});
  });
  it("routes a database backup block into backupSchedules, not fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  staging:
    applications: {}
    databases:
      postgres:
        type: postgresql
        version: "17"
        backup: { frequency: "0 3 * * *", retention: 7 }
`,
    );
    const { desired, backupSchedules } = desiredFromManifest(
      dir,
      "staging",
      {},
    );
    expect(desired[0].fields).toEqual({ type: "postgresql", version: "17" });
    expect(backupSchedules).toEqual({
      postgres: { frequency: "0 3 * * *", retention: 7 },
    });
  });
  it("warns when a service declares domains (unhonorable by apply on Coolify 4.1.2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  staging:
    applications: {}
    services:
      plausible:
        type: plausible
        domains: ["https://stats.staging.example.com"]
`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { desired } = desiredFromManifest(dir, "staging", {});
    expect(desired[0]).toMatchObject({ kind: "service", name: "plausible" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/plausible/);
    expect(warn.mock.calls[0][0]).toMatch(/domains/);
    warn.mockRestore();
  });
  it("drops domains from a domain-bearing service's fields (mirrors database backup handling)", () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  prod:
    applications: {}
    services:
      umami:
        type: umami
        domains: ["https://analytics.example.com"]
`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { desired } = desiredFromManifest(dir, "prod", {});
    expect(desired[0].fields).toEqual({ type: "umami" });
    warn.mockRestore();
  });
  it("computeDiff is clean for a domain-bearing service against a matching live service (no perpetual update)", () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  prod:
    applications: {}
    services:
      umami:
        type: umami
        domains: ["https://analytics.example.com"]
`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { desired } = desiredFromManifest(dir, "prod", {});
    warn.mockRestore();
    const report = computeDiff(
      desired,
      [
        {
          kind: "service",
          name: "umami",
          uuid: "svc-uuid",
          fields: { type: "umami" },
        },
      ],
      "structural",
    );
    expect(report.clean).toBe(true);
  });
  it("does not warn for a service with no domains", () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  staging:
    applications: {}
    services:
      plausible:
        type: plausible
`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    desiredFromManifest(dir, "staging", {});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it("resolves a dockercompose app to docker_compose_location/docker_compose_domains and no port/healthcheck/domains keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra", "env"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  prod:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: dockercompose, base_directory: /, compose_file: /docker-compose.yaml }
        service_domains:
          api: ["https://api.widget.example.com"]
        env_template: core.prod.env.template
`,
    );
    writeFileSync(
      join(dir, ".infra", "env", "core.prod.env.template"),
      "PORT=3000\n",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { desired } = desiredFromManifest(dir, "prod", {});
    warn.mockRestore();
    expect(desired).toHaveLength(1);
    expect(desired[0]).toMatchObject({
      kind: "application",
      name: "core",
      fields: {
        git_repository: "acme/widget",
        git_branch: "main",
        build_pack: "dockercompose",
        base_directory: "/",
        docker_compose_location: "/docker-compose.yaml",
        docker_compose_domains: {
          api: ["https://api.widget.example.com"],
        },
      },
    });
    expect(desired[0].fields).not.toHaveProperty("port");
    expect(desired[0].fields).not.toHaveProperty("healthcheck");
    expect(desired[0].fields).not.toHaveProperty("domains");
  });
  it('warns that apply cannot enable "Include Source Commit in Build" on a dockercompose app (unsettable via the Coolify 4.1.2 API)', () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  prod:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: dockercompose, base_directory: /, compose_file: docker-compose.yaml }
        service_domains:
          api: ["https://api.widget.example.com"]
`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { desired } = desiredFromManifest(dir, "prod", {});
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/application core/);
    expect(warn.mock.calls[0][0]).toMatch(/Include Source Commit in Build/);
    expect(warn.mock.calls[0][0]).toMatch(/Coolify UI/);
    warn.mockRestore();
    // The setting is absent from Coolify 4.1.2's create/PATCH allowlists, which
    // reject unknown keys outright — so it must never reach `fields`, or apply
    // would 422 on every run. Guards the fix a future reader would reach for.
    expect(desired[0].fields).not.toHaveProperty(
      "include_source_commit_in_build",
    );
  });
  it("does not warn about the source-commit toggle for a non-dockercompose app (the build arg is a compose concern)", () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  prod:
    applications:
      site:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["https://widget.example.com"]
`,
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    desiredFromManifest(dir, "prod", {});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it("throws when the env is missing from the manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      "project: x\nenvironments: {}\n",
    );
    expect(() => desiredFromManifest(dir, "prod", {})).toThrow(
      /environment prod not in manifest/,
    );
  });
});
