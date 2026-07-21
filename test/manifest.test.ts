import { describe, expect, it } from "vitest";
import { loadBindings } from "../src/bindings.js";
import { loadManifest } from "../src/manifest.js";

const FIX = new URL("./fixtures/", import.meta.url).pathname;

describe("loadManifest", () => {
  it("parses a valid manifest", () => {
    const m = loadManifest(`${FIX}manifest.yaml`);
    expect(m.project).toBe("widget");
    expect(m.environments.prod.applications["core-api"].build.pack).toBe(
      "nixpacks",
    );
    expect(m.environments.prod.databases?.postgres.backup?.retention).toBe(7);
  });
  it("rejects unknown build packs", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: `
project: x
environments:
  prod:
    applications:
      a:
        source: { repo: o/r, branch: main }
        build: { pack: docker-compose, base_directory: / }
        domains: []
`,
      }),
    ).toThrow(/pack/);
  });
  it("rejects instance identity in manifests (no uuid-like fields)", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: `
project: x
environments:
  prod:
    applications:
      a:
        source: { repo: o/r, branch: main }
        build: { pack: static, base_directory: / }
        domains: []
        server_uuid: abc123
`,
      }),
    ).toThrow(/unrecognized|server_uuid/i);
  });
  it("accepts a dockercompose app with compose_file + service_domains and no port/healthcheck/domains", () => {
    const m = loadManifest(`${FIX}manifest.yaml`, {
      overrideText: `
project: widget
environments:
  prod:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: dockercompose, base_directory: /, compose_file: /docker-compose.yaml }
        service_domains:
          api: ["https://api.example.com"]
        env_template: core.prod.env.template
`,
    });
    const app = m.environments.prod.applications.core;
    expect(app.build.pack).toBe("dockercompose");
    expect(app.build.compose_file).toBe("/docker-compose.yaml");
    expect(app.service_domains).toEqual({ api: ["https://api.example.com"] });
    expect(app.port).toBeUndefined();
    expect(app.healthcheck).toBeUndefined();
    expect(app.domains).toBeUndefined();
  });
  it("rejects a dockercompose app without compose_file", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: `
project: widget
environments:
  prod:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: dockercompose, base_directory: / }
        service_domains:
          api: ["https://api.example.com"]
`,
      }),
    ).toThrow(/compose_file/);
  });
  // Coolify 4.1.2 validates docker_compose_location against
  // ValidationPatterns::FILE_PATH_PATTERN on create and 422s a path with no
  // leading slash — after `apply` has already made the project and the
  // environment. The manifest knows this before any API call, so it refuses.
  it("rejects a compose_file with no leading slash, and names the fix", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: `
project: widget
environments:
  prod:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: dockercompose, base_directory: /, compose_file: docker-compose.yaml }
        service_domains:
          api: ["https://api.example.com"]
`,
      }),
    ).toThrow(/compose_file must be an absolute path.*\/docker-compose\.yaml/s);
  });
  it("rejects a compose_file that is the bare root (a directory, not a file)", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: `
project: widget
environments:
  prod:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: dockercompose, base_directory: /, compose_file: / }
        service_domains:
          api: ["https://api.example.com"]
`,
      }),
    ).toThrow(/compose_file must be an absolute path/);
  });
  it("rejects a base_directory with no leading slash", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: `
project: widget
environments:
  prod:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: apps/core }
        domains: ["https://api.example.com"]
`,
      }),
    ).toThrow(/base_directory must be an absolute path/);
  });
  it("rejects a publish_directory with no leading slash", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: `
project: widget
environments:
  prod:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: static, base_directory: /, publish_directory: dist }
        domains: ["https://api.example.com"]
`,
      }),
    ).toThrow(/publish_directory must be an absolute path/);
  });
  // Coolify's DIRECTORY_PATH_PATTERN admits the bare "/" where FILE_PATH_PATTERN
  // does not — every manifest in the wild says `base_directory: /`, so a shared
  // "absolute path" rule that rejected it would refuse every manifest cast has.
  it("accepts / as base_directory and a nested absolute publish_directory", () => {
    const m = loadManifest(`${FIX}manifest.yaml`, {
      overrideText: `
project: widget
environments:
  prod:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: static, base_directory: /, publish_directory: /apps/web/dist }
        domains: ["https://api.example.com"]
`,
    });
    const app = m.environments.prod.applications.core;
    expect(app.build.base_directory).toBe("/");
    expect(app.build.publish_directory).toBe("/apps/web/dist");
  });
  it("rejects a dockercompose app with top-level domains", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: `
project: widget
environments:
  prod:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: dockercompose, base_directory: /, compose_file: /docker-compose.yaml }
        service_domains:
          api: ["https://api.example.com"]
        domains: ["https://api.example.com"]
`,
      }),
    ).toThrow(/domains/);
  });
  it("rejects service_domains on a nixpacks app", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: `
project: widget
environments:
  prod:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["https://api.example.com"]
        service_domains:
          api: ["https://api.example.com"]
`,
      }),
    ).toThrow(/service_domains/);
  });
  // #63: the working (hand-built) config for a static site in a workspace
  // monorepo — is_static plus workspace-scoped install/build commands that build
  // only the target app and serve its dist, instead of the repo root's start
  // script booting a different workspace.
  it("accepts install/build/start commands and static on a non-compose app, round-tripping them", () => {
    const m = loadManifest(`${FIX}manifest.yaml`, {
      overrideText: `
project: widget
environments:
  prod:
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
    });
    const b = m.environments.prod.applications.landing.build;
    expect(b.install_command).toBe("npm ci");
    expect(b.build_command).toBe("npm run build -w apps/landing-site");
    expect(b.start_command).toBe("node server.js");
    expect(b.static).toBe(true);
    expect(b.publish_directory).toBe("/apps/landing-site/dist");
  });
  it("rejects static: true with nothing to serve (no publish_directory)", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: `
project: widget
environments:
  prod:
    applications:
      landing:
        source: { repo: acme/widget, branch: main }
        build: { pack: static, base_directory: /, static: true }
        domains: ["https://landing.example.com"]
`,
      }),
    ).toThrow(/nothing to serve/);
  });
  it("rejects install/build/start commands and static on a dockercompose app", () => {
    for (const field of [
      "install_command: npm ci",
      "build_command: npm run build",
      "start_command: node server.js",
      "static: true",
    ]) {
      expect(() =>
        loadManifest(`${FIX}manifest.yaml`, {
          overrideText: `
project: widget
environments:
  prod:
    applications:
      core:
        source: { repo: acme/widget, branch: main }
        build: { pack: dockercompose, base_directory: /, compose_file: /docker-compose.yaml, ${field} }
        service_domains:
          api: ["https://api.example.com"]
`,
        }),
      ).toThrow(/not allowed on a dockercompose app/);
    }
  });
});

// HTTP basic auth on an application (cast#76). The schema carries three rules,
// and each is here because breaking it is expensive somewhere else: the password
// must be a store ref (a literal is a password in git, forever), enabling needs
// both credentials (Coolify 422s mid-run otherwise, and half-configured basic
// auth protects nothing), and a disabled block must carry none (a credential
// standing over a disabled auth reads like a guard and is not one).
describe("loadManifest — basic_auth (#76)", () => {
  const app = (basicAuth: string) => `
project: x
environments:
  prod:
    applications:
      admin:
        source: { repo: o/r, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["https://admin.example.com"]
        basic_auth: ${basicAuth}
`;

  it("accepts an enabled block whose password is a ${REF}", () => {
    const m = loadManifest(`${FIX}manifest.yaml`, {
      overrideText: app(
        "{ enabled: true, username: ops, password: '${ADMIN_PW}' }",
      ),
    });
    expect(m.environments.prod.applications.admin.basic_auth).toEqual({
      enabled: true,
      username: "ops",
      password: "${ADMIN_PW}",
    });
  });

  it("accepts a bare `enabled: false` — the way to assert basic auth is OFF", () => {
    const m = loadManifest(`${FIX}manifest.yaml`, {
      overrideText: app("{ enabled: false }"),
    });
    expect(m.environments.prod.applications.admin.basic_auth).toEqual({
      enabled: false,
    });
  });

  it("treats an omitted block as saying nothing at all", () => {
    const m = loadManifest(`${FIX}manifest.yaml`, {
      overrideText: `
project: x
environments:
  prod:
    applications:
      admin:
        source: { repo: o/r, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["https://admin.example.com"]
`,
    });
    expect(m.environments.prod.applications.admin.basic_auth).toBeUndefined();
  });

  // The non-negotiable. A literal here would be a live password in a reviewed,
  // committed file — so it is unrepresentable, not discouraged.
  it("REFUSES a literal password", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: app(
          "{ enabled: true, username: ops, password: hunter2 }",
        ),
      }),
    ).toThrow(/must be a store ref/);
  });

  it("refuses a password that is a ref with anything around it", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: app(
          "{ enabled: true, username: ops, password: 'pre-${ADMIN_PW}' }",
        ),
      }),
    ).toThrow(/must be a store ref/);
  });

  // Coolify's own presence rule, failing in the FILE rather than as a 422 from a
  // PATCH in the middle of a run.
  it("refuses enabling without a password", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: app("{ enabled: true, username: ops }"),
      }),
    ).toThrow(
      /basic_auth.password is required when basic_auth.enabled is true/,
    );
  });

  it("refuses enabling without a username", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: app("{ enabled: true, password: '${ADMIN_PW}' }"),
      }),
    ).toThrow(
      /basic_auth.username is required when basic_auth.enabled is true/,
    );
  });

  it("refuses credentials declared alongside `enabled: false`", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: app("{ enabled: false, username: ops }"),
      }),
    ).toThrow(/not allowed when basic_auth.enabled is false/);
  });

  it("refuses a block with no `enabled` at all — the toggle is never inferred", () => {
    expect(() =>
      loadManifest(`${FIX}manifest.yaml`, {
        overrideText: app("{ username: ops, password: '${ADMIN_PW}' }"),
      }),
    ).toThrow(/enabled/);
  });
});

describe("loadBindings", () => {
  it("parses bindings", () => {
    const b = loadBindings(`${FIX}environments.yaml`);
    expect(b.environments.prod.server).toBe("prod-box");
    expect(b.github_apps.widget).toBe("my-github-app");
  });
  it("carries an environment's forbidden_var_patterns through", () => {
    const b = loadBindings(`${FIX}environments.yaml`);
    expect(b.environments.prod.forbidden_var_patterns).toEqual(["^ALLOW_"]);
    expect(b.environments.staging.forbidden_var_patterns).toBeUndefined();
  });
  it("carries an environment's expected team through", () => {
    const b = loadBindings(`${FIX}environments.yaml`);
    expect(b.environments.prod.team).toEqual({ id: 1, name: "heavy-duty" });
  });
  // Fail-closed at the schema: an environment with no declared team is one
  // whose token cannot be verified, and an unverifiable target is exactly the
  // duplicate-into-the-wrong-team failure the binding exists to prevent.
  it("rejects an environment with no team", () => {
    expect(() =>
      loadBindings(`${FIX}environments.yaml`, {
        overrideText: `
environments:
  prod: { server: prod-box }
github_apps: { widget: my-github-app }
`,
      }),
    ).toThrow(/team/);
  });
  it("rejects a team that names neither id nor name", () => {
    expect(() =>
      loadBindings(`${FIX}environments.yaml`, {
        overrideText: `
environments:
  prod: { server: prod-box, team: {} }
github_apps: { widget: my-github-app }
`,
      }),
    ).toThrow(/at least one of/);
  });
  // Coolify's Root Team is id 0 (app/Models/User.php @ v4.1.2) — the team a
  // single-admin instance keeps everything in. Rejecting it would make the id
  // check unusable on exactly the topology that most needs it.
  it("accepts team id 0, the Root Team", () => {
    const b = loadBindings(`${FIX}environments.yaml`, {
      overrideText: `
environments:
  prod: { server: prod-box, team: { id: 0, name: Root Team } }
github_apps: { widget: my-github-app }
`,
    });
    expect(b.environments.prod.team).toEqual({ id: 0, name: "Root Team" });
  });
  it("accepts a team given by id alone, or by name alone", () => {
    const byId = loadBindings(`${FIX}environments.yaml`, {
      overrideText: `
environments:
  prod: { server: prod-box, team: { id: 2 } }
github_apps: { widget: my-github-app }
`,
    });
    expect(byId.environments.prod.team).toEqual({ id: 2 });
    const byName = loadBindings(`${FIX}environments.yaml`, {
      overrideText: `
environments:
  prod: { server: prod-box, team: { name: heavy-duty } }
github_apps: { widget: my-github-app }
`,
    });
    expect(byName.environments.prod.team).toEqual({ name: "heavy-duty" });
  });
});
