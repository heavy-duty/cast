import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeDiff } from "../src/diff.js";
import { DERIVED_UNRESOLVED } from "../src/envtemplate.js";
import {
  cloneFailureMessage,
  desiredFromManifest,
  fillDesiredDerived,
  requiredSecrets,
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
    const { desired, resolvedEnvs } = desiredFromManifest(dir, "staging", {
      MG: "secret-v",
    });
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
    // None of the four build settings are emitted for an app that declares none:
    // managing is_static is opt-in (declaring it would otherwise PATCH static
    // serving OFF on an un-migrated app), and the commands default to "let the
    // build pack decide".
    expect(desired[0].fields).not.toHaveProperty("is_static");
    expect(desired[0].fields).not.toHaveProperty("install_command");
    expect(desired[0].fields).not.toHaveProperty("build_command");
    expect(desired[0].fields).not.toHaveProperty("start_command");
  });
  it("emits is_static:false when static:false is explicitly declared (a guard against a UI flip)", () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  staging:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: /, static: false }
        domains: ["https://c.example.com"]
`,
    );
    const { desired } = desiredFromManifest(dir, "staging", {});
    expect(desired[0].fields.is_static).toBe(false);
  });
  // #63: the static-site build settings a workspace monorepo needs.
  it("emits is_static:true and the three commands for a non-compose app that declares them", () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  staging:
    applications:
      landing:
        source: { repo: acme/widget, branch: main }
        build:
          pack: static
          base_directory: /
          publish_directory: /apps/landing-site/dist
          install_command: npm ci
          build_command: npm run build -w apps/landing-site
          start_command: node server.js
          static: true
        domains: ["https://landing.example.com"]
`,
    );
    const { desired } = desiredFromManifest(dir, "staging", {});
    expect(desired[0].fields).toMatchObject({
      is_static: true,
      install_command: "npm ci",
      build_command: "npm run build -w apps/landing-site",
      start_command: "node server.js",
      publish_directory: "/apps/landing-site/dist",
    });
  });
  // The reverse of what this file used to assert. `backup` was deliberately
  // routed AROUND `fields` into a side channel, because live Coolify was
  // believed not to expose a schedule back; it does (GET
  // /databases/{uuid}/backups), and the side channel is what made a `backup:`
  // block added to an existing database silently do nothing (#51).
  it("puts a database backup block in fields, so it is diffed like any other", () => {
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
    const { desired } = desiredFromManifest(dir, "staging", {});
    expect(desired[0].fields).toEqual({
      type: "postgresql",
      version: "17",
      backup: { frequency: "0 3 * * *", retention: 7 },
    });
  });
  it("leaves `backup` out of fields entirely when none is declared", () => {
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
`,
    );
    const { desired } = desiredFromManifest(dir, "staging", {});
    expect(desired[0].fields).toEqual({ type: "postgresql", version: "17" });
    // Undeclared means uncompared, NOT "delete whatever is there": a live
    // schedule on a database whose manifest says nothing about backups is left
    // alone, like every other thing apply never removes.
    expect("backup" in desired[0].fields).toBe(false);
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
    // A compose app builds from its compose file — none of the static/command
    // fields belong on it, not even is_static (which every NON-compose app gets).
    expect(desired[0].fields).not.toHaveProperty("is_static");
    expect(desired[0].fields).not.toHaveProperty("install_command");
    expect(desired[0].fields).not.toHaveProperty("build_command");
    expect(desired[0].fields).not.toHaveProperty("start_command");
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
        build: { pack: dockercompose, base_directory: /, compose_file: /docker-compose.yaml }
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

describe("derived resource refs (#60)", () => {
  // A manifest with one app whose template derives a DB URL, plus the database
  // the ref names. `dbName` and `attr` are knobs the validation cases turn.
  const write = (
    ref = "${resource:postgres.url}",
    dbBlock = "    databases:\n      postgres: { type: postgresql }\n",
  ): string => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra", "env"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  staging:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: /apps/core }
        domains: ["http://api.example.com"]
        env_template: core.staging.env.template
${dbBlock}`,
    );
    writeFileSync(
      join(dir, ".infra", "env", "core.staging.env.template"),
      `DATABASE_URL=${ref}\n`,
    );
    return dir;
  };

  it("emits a derived var (unresolved) and does not demand it as a secret", () => {
    const dir = write();
    const { desired } = desiredFromManifest(dir, "staging", {});
    const app = desired.find((d) => d.name === "core");
    expect(app?.env?.vars.DATABASE_URL).toEqual({
      value: DERIVED_UNRESOLVED,
      secret: true,
      derived: { resource: "postgres", attr: "url" },
    });
    // capture's view: it is NOT a required store secret.
    const req = requiredSecrets(dir, "staging");
    expect(req.required.map((r) => r.ref)).not.toContain(
      "resource:postgres.url",
    );
    expect(req.required).toHaveLength(0);
  });

  it("fillDesiredDerived fills it from a URL map keyed by manifest name", () => {
    const dir = write();
    const { desired } = desiredFromManifest(dir, "staging", {});
    const filled = fillDesiredDerived(desired, {
      postgres: "postgres://u:p@uuid:5432/db",
    });
    const app = filled.find((d) => d.name === "core");
    expect(app?.env?.vars.DATABASE_URL.value).toBe(
      "postgres://u:p@uuid:5432/db",
    );
  });

  it("hard-refuses a ref naming a database the manifest does not declare", () => {
    // No databases block at all — the ref points at nothing.
    const dir = write("${resource:postgres.url}", "");
    expect(() => desiredFromManifest(dir, "staging", {})).toThrow(
      /no database named postgres/,
    );
    // capture refuses it too, in the same voice — every verb that opens a template.
    expect(() => requiredSecrets(dir, "staging")).toThrow(
      /no database named postgres/,
    );
  });

  it("hard-refuses an attribute other than .url", () => {
    const dir = write("${resource:postgres.password}");
    expect(() => desiredFromManifest(dir, "staging", {})).toThrow(
      /unknown resource attribute/,
    );
  });
});

describe("derived domain refs (#66)", () => {
  // Assemble a manifest from an applications block plus one env template. The
  // env_template line is appended to whichever app comes last in `apps`.
  const write = (apps: string, tmpl: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "infra-co-"));
    mkdirSync(join(dir, ".infra", "env"), { recursive: true });
    writeFileSync(
      join(dir, ".infra", "manifest.yaml"),
      `project: widget
environments:
  prod:
    applications:
${apps}`,
    );
    writeFileSync(join(dir, ".infra", "env", "refs.env.template"), tmpl);
    return dir;
  };

  // A plain app (a `domains` list) and a compose app (`service_domains`); the
  // env_template line appended after either makes that app carry the template.
  const LANDING = `      landing:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["https://new.heavyduty.builders"]
`;
  const CORE = `      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: dockercompose, base_directory: /, compose_file: /docker-compose.yaml }
        service_domains:
          admin: ["https://admin.heavyduty.builders"]
`;
  const TMPL = "        env_template: refs.env.template\n";

  it("resolves ${domain:<app>} and ${domain:<app>.<service>} to the manifest's domains, secret:false", () => {
    const dir = write(
      LANDING + CORE + TMPL,
      "ADMIN_WEB_BASE_URL=${domain:core.admin}\nLANDING_BASE_URL=${domain:landing}\n",
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { desired, resolvedEnvs } = desiredFromManifest(dir, "prod", {});
    warn.mockRestore();
    const core = desired.find((d) => d.name === "core");
    // The app.service ref and the app ref both resolve to the verbatim domain
    // (scheme and all), public, and with no `domain` marker — a plain literal.
    expect(core?.env?.vars.ADMIN_WEB_BASE_URL).toEqual({
      value: "https://admin.heavyduty.builders",
      secret: false,
    });
    expect(core?.env?.vars.LANDING_BASE_URL).toEqual({
      value: "https://new.heavyduty.builders",
      secret: false,
    });
    // resolvedEnvs is domain-filled too, and no sentinel escapes anywhere.
    expect(resolvedEnvs.core.vars.LANDING_BASE_URL.value).toBe(
      "https://new.heavyduty.builders",
    );
    expect(JSON.stringify(desired)).not.toContain("cast:unresolved-domain-ref");
  });

  it("does not list domain refs as required secrets (capture validates but never captures them)", () => {
    const dir = write(
      LANDING + CORE + TMPL,
      "ADMIN_WEB_BASE_URL=${domain:core.admin}\nLANDING_BASE_URL=${domain:landing}\nMG=${MG}\n",
    );
    const req = requiredSecrets(dir, "prod");
    // Only the real ${MG} secret is required — the two domain refs are not.
    expect(req.required.map((r) => r.ref)).toEqual(["MG"]);
  });

  it("refuses a ref naming an application the manifest does not declare", () => {
    const dir = write(LANDING + TMPL, "X=${domain:nope}\n");
    expect(() => requiredSecrets(dir, "prod")).toThrow(
      /no application named nope/,
    );
    // Every verb that opens a template refuses it, in the same voice.
    expect(() => desiredFromManifest(dir, "prod", {})).toThrow(
      /no application named nope/,
    );
  });

  it("refuses ${domain:<app>} on a compose app whose domains live per service", () => {
    const dir = write(CORE + TMPL, "X=${domain:core}\n");
    expect(() => requiredSecrets(dir, "prod")).toThrow(
      /domains live per service/,
    );
  });

  it("refuses ${domain:<app>.<service>} on an app that declares a plain domains list", () => {
    const dir = write(LANDING + TMPL, "X=${domain:landing.admin}\n");
    expect(() => requiredSecrets(dir, "prod")).toThrow(/plain `domains` list/);
  });

  it("refuses a service the app's service_domains does not declare", () => {
    const dir = write(CORE + TMPL, "X=${domain:core.nope}\n");
    expect(() => requiredSecrets(dir, "prod")).toThrow(/no service named nope/);
  });

  it("refuses a ref whose selected domain list is declared but empty", () => {
    const dir = write(
      `      landing:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: []
${TMPL}`,
      "X=${domain:landing}\n",
    );
    expect(() => requiredSecrets(dir, "prod")).toThrow(/domain list is empty/);
  });

  it('refuses a ref whose selected list has a blank first entry (domains: [""]) — the sentinel must not escape', () => {
    const dir = write(
      `      landing:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: [""]
${TMPL}`,
      "X=${domain:landing}\n",
    );
    // Schema-valid (a non-empty array of strings), so it PASSES manifest load —
    // the assert is the gate. buildDomainMap would store "" and fillDomainEnv
    // would read "" as unresolved, leaving DOMAIN_UNRESOLVED in a returned env.
    expect(() => requiredSecrets(dir, "prod")).toThrow(
      /empty or its first entry is blank/,
    );
    // Every verb that opens a template refuses it — the sentinel never escapes
    // into a returned desired set.
    expect(() => desiredFromManifest(dir, "prod", {})).toThrow(
      /empty or its first entry is blank/,
    );
  });

  it('refuses a service ref whose selected list has a blank first entry (service_domains: {admin: [""]})', () => {
    const dir = write(
      `      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: dockercompose, base_directory: /, compose_file: /docker-compose.yaml }
        service_domains:
          admin: [""]
${TMPL}`,
      "X=${domain:core.admin}\n",
    );
    expect(() => requiredSecrets(dir, "prod")).toThrow(
      /empty or its first entry is blank/,
    );
  });

  it("gives the domains-app-shape message (not 'no service named') for a service ref against an empty-domains app", () => {
    // An empty `domains: []` is still a domains app (shape is by key presence).
    // A ${domain:app.svc} ref against it is a spurious-service error, not an
    // unknown-service one.
    const dir = write(
      `      landing:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: []
${TMPL}`,
      "X=${domain:landing.admin}\n",
    );
    expect(() => requiredSecrets(dir, "prod")).toThrow(/plain `domains` list/);
  });
});
