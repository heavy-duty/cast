import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { computeDiff } from "../src/diff.js";
import { desiredFromManifest, resolveCheckout } from "../src/resolve.js";

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
        build: { pack: dockercompose, base_directory: /, compose_file: docker-compose.yaml }
        service_domains:
          api: ["https://api.widget.example.com"]
        env_template: core.prod.env.template
`,
    );
    writeFileSync(
      join(dir, ".infra", "env", "core.prod.env.template"),
      "PORT=3000\n",
    );
    const { desired } = desiredFromManifest(dir, "prod", {});
    expect(desired).toHaveLength(1);
    expect(desired[0]).toMatchObject({
      kind: "application",
      name: "core",
      fields: {
        git_repository: "acme/widget",
        git_branch: "main",
        build_pack: "dockercompose",
        base_directory: "/",
        docker_compose_location: "docker-compose.yaml",
        docker_compose_domains: {
          api: ["https://api.widget.example.com"],
        },
      },
    });
    expect(desired[0].fields).not.toHaveProperty("port");
    expect(desired[0].fields).not.toHaveProperty("healthcheck");
    expect(desired[0].fields).not.toHaveProperty("domains");
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
