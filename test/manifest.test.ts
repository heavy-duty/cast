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
        build: { pack: dockercompose, base_directory: /, compose_file: docker-compose.yaml }
        service_domains:
          api: ["https://api.example.com"]
        env_template: core.prod.env.template
`,
    });
    const app = m.environments.prod.applications.core;
    expect(app.build.pack).toBe("dockercompose");
    expect(app.build.compose_file).toBe("docker-compose.yaml");
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
        build: { pack: dockercompose, base_directory: /, compose_file: docker-compose.yaml }
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
});
