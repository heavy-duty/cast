import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applicationApiFields,
  parseDockerComposeDomains,
  projectLiveFields,
} from "../src/cli.js";
import { computeDiff } from "../src/diff.js";
import { type DraftProject, planDraft } from "../src/draft.js";
import { loadManifest } from "../src/manifest.js";
import { desiredFromManifest } from "../src/resolve.js";
import { tmp } from "./helpers/tmp.js";

// The `dockerimage` build pack (cast#161): an application deployed from a
// registry image, with no git source, created through Coolify's own route for
// it, whose image and tag are ordinary diffed fields — and, on every non-compose
// pack, a declared `healthcheck` that actually ENABLES Coolify's health check.
// Each half is proven here at the unit it lives in; dockerimage-cli.test.ts
// proves they are wired to each other through the real binary.

const FIX = new URL("./fixtures/", import.meta.url).pathname;

const manifest = (app: string) =>
  loadManifest(`${FIX}manifest.yaml`, {
    overrideText: `
project: widget
environments:
  prod:
    applications:
      site:
${app
  .trim()
  .split("\n")
  .map((l) => `        ${l}`)
  .join("\n")}
`,
  });

const SITE = `
image: { name: ghcr.io/acme/widget, tag: stable }
build: { pack: dockerimage }
port: 80
healthcheck: /version
domains: ["https://widget.example.com"]
`;

describe("manifest — the dockerimage pack (cast#161)", () => {
  it("accepts image + domains + port, with no source and no checkout path", () => {
    const app = manifest(SITE).environments.prod.applications.site;
    expect(app.build.pack).toBe("dockerimage");
    expect(app.image).toEqual({ name: "ghcr.io/acme/widget", tag: "stable" });
    expect(app.source).toBeUndefined();
    expect(app.build.base_directory).toBeUndefined();
    expect(app.port).toBe(80);
    expect(app.healthcheck).toBe("/version");
  });
  it("accepts Coolify's digest spelling as a tag", () => {
    const app = manifest(
      SITE.replace("tag: stable", `tag: sha256-${"a".repeat(64)}`),
    ).environments.prod.applications.site;
    expect(app.image?.tag).toBe(`sha256-${"a".repeat(64)}`);
  });
  it("requires image, domains and port, each named", () => {
    expect(() => manifest(SITE.replace(/image:.*\n/, ""))).toThrow(
      /dockerimage apps require image: \{ name, tag \}/,
    );
    expect(() => manifest(SITE.replace(/domains:.*\n/, ""))).toThrow(
      /domains required \(dockerimage app\)/,
    );
    expect(() => manifest(SITE.replace(/port:.*\n/, ""))).toThrow(
      /port required on a dockerimage app/,
    );
  });
  it("refuses a source, every checkout and build setting, and service_domains", () => {
    expect(() =>
      manifest(`${SITE}source: { repo: acme/widget, branch: main }\n`),
    ).toThrow(/source not allowed on a dockerimage app/);
    for (const [key, value] of [
      ["base_directory", "/"],
      ["publish_directory", "/dist"],
      ["compose_file", "/docker-compose.yaml"],
      ["install_command", "npm ci"],
      ["build_command", "npm run build"],
      ["start_command", "npm start"],
      ["static", "true"],
    ]) {
      expect(
        () =>
          manifest(
            SITE.replace(
              "build: { pack: dockerimage }",
              `build: { pack: dockerimage, ${key}: ${value} }`,
            ),
          ),
        key,
      ).toThrow(new RegExp(`build\\.${key} not allowed on a dockerimage app`));
    }
    expect(() =>
      manifest(`${SITE}service_domains: { api: ["https://x"] }\n`),
    ).toThrow(/service_domains only allowed with pack dockercompose/);
  });
  it("refuses a name that carries its tag, since Coolify would split and re-store it", () => {
    expect(() =>
      manifest(
        SITE.replace(
          "name: ghcr.io/acme/widget",
          "name: ghcr.io/acme/widget:stable",
        ),
      ),
    ).toThrow(/image\.name is the repository only/);
    expect(() => manifest(SITE.replace("tag: stable", 'tag: "a b"'))).toThrow(
      /image\.tag must be a docker tag/,
    );
  });
  it("still requires source and base_directory on every git-sourced pack, and refuses image there", () => {
    expect(() =>
      manifest(`
build: { pack: nixpacks, base_directory: / }
domains: ["https://x"]
`),
    ).toThrow(/source required \(a nixpacks app is cloned from source/);
    expect(() =>
      manifest(`
source: { repo: acme/widget, branch: main }
build: { pack: nixpacks }
domains: ["https://x"]
`),
    ).toThrow(/build\.base_directory required/);
    expect(() =>
      manifest(`
source: { repo: acme/widget, branch: main }
image: { name: ghcr.io/acme/widget, tag: stable }
build: { pack: static, base_directory: / }
domains: ["https://x"]
`),
    ).toThrow(/image only allowed with pack dockerimage/);
  });
  it("accepts a compose service declared internal-only (an empty domain list)", () => {
    const app = manifest(`
source: { repo: acme/widget, branch: main }
build: { pack: dockercompose, base_directory: /, compose_file: /docker-compose.yaml }
service_domains: { api: [] }
`).environments.prod.applications.site;
    expect(app.service_domains).toEqual({ api: [] });
  });
});

function checkout(apps: string): string {
  const dir = tmp("cast-image-");
  mkdirSync(join(dir, ".infra", "env"), { recursive: true });
  writeFileSync(
    join(dir, ".infra", "manifest.yaml"),
    `project: widget\nenvironments:\n  prod:\n    applications:\n${apps}`,
  );
  return dir;
}

describe("resolve — what a dockerimage app is on the wire", () => {
  it("emits the image name and tag, and nothing of a checkout", () => {
    const { desired } = desiredFromManifest(
      checkout(`      site:
        image: { name: ghcr.io/acme/widget, tag: stable }
        build: { pack: dockerimage }
        port: 80
        healthcheck: /version
        domains: ["https://widget.example.com"]
`),
      "prod",
      {},
    );
    expect(desired[0].fields).toEqual({
      build_pack: "dockerimage",
      docker_registry_image_name: "ghcr.io/acme/widget",
      docker_registry_image_tag: "stable",
      port: 80,
      healthcheck: "/version",
      health_check_enabled: true,
      domains: ["https://widget.example.com"],
    });
    // Not declared, so never compared: Coolify stamps coollabsio/coolify on
    // such an app and cast must not read that as drift.
    expect(desired[0].fields).not.toHaveProperty("git_repository");
    expect(desired[0].fields).not.toHaveProperty("base_directory");
  });
  it("a declared healthcheck enables the check on every non-compose pack, an absent one says nothing", () => {
    const { desired } = desiredFromManifest(
      checkout(`      checked:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: / }
        healthcheck: /health
        domains: ["https://a.example.com"]
      silent:
        source: { repo: acme/widget, branch: main }
        build: { pack: nixpacks, base_directory: / }
        domains: ["https://b.example.com"]
`),
      "prod",
      {},
    );
    expect(desired[0].fields).toMatchObject({
      healthcheck: "/health",
      health_check_enabled: true,
    });
    expect(desired[1].fields).not.toHaveProperty("healthcheck");
    expect(desired[1].fields).not.toHaveProperty("health_check_enabled");
  });
});

describe("wire — image fields and the health-check toggle", () => {
  it("applicationApiFields passes the image fields and the toggle through untranslated", () => {
    expect(
      applicationApiFields({
        docker_registry_image_name: "ghcr.io/acme/widget",
        docker_registry_image_tag: "stable",
        port: 80,
        healthcheck: "/version",
        health_check_enabled: true,
        domains: ["https://widget.example.com"],
      }),
    ).toEqual({
      docker_registry_image_name: "ghcr.io/acme/widget",
      docker_registry_image_tag: "stable",
      ports_exposes: "80",
      health_check_path: "/version",
      health_check_enabled: true,
      domains: "https://widget.example.com",
    });
  });
  it("projectLiveFields reads the image back, and the toggle in either serialization", () => {
    const base = {
      git_repository: "coollabsio/coolify",
      git_branch: "main",
      build_pack: "dockerimage",
      base_directory: "/",
      docker_registry_image_name: "ghcr.io/acme/widget",
      docker_registry_image_tag: "stable",
      ports_exposes: "80",
      health_check_path: "/version",
      fqdn: "https://widget.example.com",
    };
    expect(projectLiveFields("application", base)).toMatchObject({
      docker_registry_image_name: "ghcr.io/acme/widget",
      docker_registry_image_tag: "stable",
      healthcheck: "/version",
    });
    expect(projectLiveFields("application", base)).not.toHaveProperty(
      "health_check_enabled",
    );
    for (const [raw, projected] of [
      [true, true],
      [1, true],
      [false, false],
      [0, false],
    ]) {
      expect(
        projectLiveFields("application", { ...base, health_check_enabled: raw })
          .health_check_enabled,
      ).toBe(projected);
    }
  });
  it("projectLiveFields leaves a git-sourced app's null image columns out", () => {
    const out = projectLiveFields("application", {
      git_repository: "acme/widget",
      git_branch: "main",
      build_pack: "nixpacks",
      base_directory: "/",
      docker_registry_image_name: null,
      docker_registry_image_tag: null,
      fqdn: "https://a.example.com",
    });
    expect(out).not.toHaveProperty("docker_registry_image_name");
    expect(out).not.toHaveProperty("docker_registry_image_tag");
  });
  it("parseDockerComposeDomains keeps a service whose domain is null or empty, as an empty list", () => {
    expect(
      parseDockerComposeDomains(
        JSON.stringify({ api: { domain: null }, web: { domain: "https://w" } }),
      ),
    ).toEqual({ api: [], web: ["https://w"] });
    expect(
      parseDockerComposeDomains(JSON.stringify([{ name: "api", domain: "" }])),
    ).toEqual({ api: [] });
  });
});

describe("diff — a switched-off check and a moved tag are drift; the stamped git remote is not", () => {
  const site = {
    kind: "application" as const,
    name: "site",
    fields: {
      build_pack: "dockerimage",
      docker_registry_image_name: "ghcr.io/acme/widget",
      docker_registry_image_tag: "stable",
      port: 80,
      healthcheck: "/version",
      health_check_enabled: true,
      domains: ["https://widget.example.com"],
    },
  };
  const live = (over: Record<string, unknown> = {}) => ({
    kind: "application" as const,
    name: "site",
    uuid: "u1",
    fields: projectLiveFields("application", {
      git_repository: "coollabsio/coolify",
      git_branch: "main",
      build_pack: "dockerimage",
      base_directory: "/",
      docker_registry_image_name: "ghcr.io/acme/widget",
      docker_registry_image_tag: "stable",
      ports_exposes: "80",
      health_check_path: "/version",
      health_check_enabled: true,
      fqdn: "https://widget.example.com",
      ...over,
    }),
    env: {},
  });
  it("is clean when the image, tag and check match, whatever git remote Coolify stamped", () => {
    expect(computeDiff([site], [live()], "full").clean).toBe(true);
  });
  it("reports a live check switched off under a declared path, as an updatable field", () => {
    const r = computeDiff(
      [site],
      [live({ health_check_enabled: false })],
      "full",
    );
    expect(r.changes[0].fieldDiffs).toEqual([
      {
        field: "health_check_enabled",
        desired: true,
        live: false,
        updatable: true,
      },
    ]);
  });
  it("reports a moved tag as an updatable field, never a recreate", () => {
    const r = computeDiff(
      [site],
      [live({ docker_registry_image_tag: "2.0.0-rc2" })],
      "full",
    );
    expect(r.changes[0].fieldDiffs).toEqual([
      {
        field: "docker_registry_image_tag",
        desired: "stable",
        live: "2.0.0-rc2",
        updatable: true,
      },
    ]);
  });
  it("an internal-only compose service reads back clean", () => {
    const admin = {
      kind: "application" as const,
      name: "admin",
      fields: {
        build_pack: "dockercompose",
        docker_compose_domains: { api: [] as string[] },
      },
    };
    const r = computeDiff(
      [admin],
      [
        {
          kind: "application",
          name: "admin",
          uuid: "u2",
          fields: projectLiveFields("application", {
            build_pack: "dockercompose",
            docker_compose_domains: JSON.stringify({ api: { domain: null } }),
          }),
          env: {},
        },
      ],
      "full",
    );
    expect(r.clean).toBe(true);
  });
});

describe("draft — a Docker Image application is drafted by its image, not by the git remote Coolify stamps", () => {
  const ctx = {
    env: "prod",
    instance: "box-b",
    baseUrl: "https://coolify.example.com",
    team: { id: 0, name: "Root Team" },
    server: "box-b",
    recipient: "age1example",
    generatedAt: "2026-09-24T00:00:00.000Z",
  };
  const project = (raw: Record<string, unknown>): DraftProject => ({
    name: "widget",
    coolifyEnv: "prod",
    resources: [
      {
        kind: "application",
        name: "site",
        uuid: "a1",
        raw: {
          git_repository: "coollabsio/coolify",
          git_branch: "main",
          build_pack: "dockerimage",
          base_directory: "/",
          docker_registry_image_name: "ghcr.io/acme/widget",
          docker_registry_image_tag: "stable",
          ports_exposes: "80",
          health_check_path: "/version",
          fqdn: "https://widget.example.com",
          destination_id: 3,
          ...raw,
        },
        env: {},
      },
    ],
    unreadable: [],
    otherEnvironments: [],
  });
  const drafted = (raw: Record<string, unknown> = {}) => {
    const plan = planDraft([project(raw)], ctx);
    const file = plan.files.find((f) => f.path.endsWith("manifest.yaml"));
    const path = join(tmp("cast-draft-image-"), "manifest.yaml");
    writeFileSync(path, file?.content ?? "");
    return {
      app: loadManifest(path).environments.prod.applications.site,
      plan,
    };
  };
  it("emits image, port, healthcheck and domains, and no source", () => {
    const { app, plan } = drafted();
    expect(app.build).toEqual({ pack: "dockerimage" });
    expect(app.image).toEqual({ name: "ghcr.io/acme/widget", tag: "stable" });
    expect(app.port).toBe(80);
    expect(app.healthcheck).toBe("/version");
    expect(app.domains).toEqual(["https://widget.example.com"]);
    expect(app.source).toBeUndefined();
    expect(plan.uncaptured.filter((u) => u.resource === "site")).toEqual([]);
  });
  it("says so when the box reports no tag or no port, and still loads", () => {
    const { app, plan } = drafted({
      docker_registry_image_tag: "",
      ports_exposes: "",
    });
    expect(app.image?.tag).toBe("latest");
    expect(app.port).toBe(80);
    expect(plan.uncaptured.map((u) => u.setting)).toEqual(
      expect.arrayContaining(["image.tag", "port"]),
    );
  });
});
