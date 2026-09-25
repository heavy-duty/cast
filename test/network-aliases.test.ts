import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applicationApiFields, projectLiveFields } from "../src/cli.js";
import { computeDiff } from "../src/diff.js";
import { type DraftProject, planDraft } from "../src/draft.js";
import { loadManifest } from "../src/manifest.js";
import { desiredFromManifest, parseNetworkAliases } from "../src/resolve.js";
import { tmp } from "./helpers/tmp.js";

// `network_aliases` on a non-compose application (cast#170): Coolify's
// `custom_network_aliases`, the names another resource on the destination
// network reaches this one by. Each half proven at its unit;
// network-aliases-cli.test.ts proves the wire through the real binary.

const FIX = new URL("./fixtures/", import.meta.url).pathname;
const manifest = (app: string) =>
  loadManifest(`${FIX}manifest.yaml`, {
    overrideText: `
project: widget
environments:
  prod:
    applications:
      admin:
${app
  .trim()
  .split("\n")
  .map((l) => `        ${l}`)
  .join("\n")}
`,
  });
const refusal = (app: string) => {
  try {
    manifest(app);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("the manifest loaded");
};
const checkout = (app: string) => {
  const dir = tmp("cast-aliases-co-");
  mkdirSync(join(dir, ".infra"), { recursive: true });
  writeFileSync(
    join(dir, ".infra", "manifest.yaml"),
    `project: widget\nenvironments:\n  prod:\n    applications:\n      admin:\n${app
      .trim()
      .split("\n")
      .map((l) => `        ${l}`)
      .join("\n")}\n`,
  );
  return dir;
};

const ADMIN = `
image: { name: ghcr.io/acme/admin, tag: stable }
build: { pack: dockerimage }
port: 8787
network_aliases: [api]
domains: []
`;

describe("manifest — network_aliases on a non-compose application (cast#170)", () => {
  it("is accepted on dockerimage, nixpacks, dockerfile and static", () => {
    expect(
      manifest(ADMIN).environments.prod.applications.admin.network_aliases,
    ).toEqual(["api"]);
    for (const pack of ["nixpacks", "dockerfile", "static"]) {
      const m = manifest(`
source: { repo: acme/admin, branch: main }
build: { pack: ${pack}, base_directory: / }
domains: ["https://admin.example.com"]
network_aliases: [api, admin.internal]
`);
      expect(
        m.environments.prod.applications.admin.network_aliases,
        pack,
      ).toEqual(["api", "admin.internal"]);
    }
  });
  it("is refused on a dockercompose app, naming the compose file", () => {
    expect(
      refusal(`
source: { repo: acme/admin, branch: main }
build: { pack: dockercompose, base_directory: /, compose_file: /docker-compose.yaml }
service_domains: { api: [] }
network_aliases: [api]
`),
    ).toMatch(
      /network_aliases not allowed on a dockercompose app .*compose file/,
    );
  });
  it("refuses a comma, a space, a leading '-' and a duplicate", () => {
    const withAliases = (list: string) =>
      refusal(
        ADMIN.replace("network_aliases: [api]", `network_aliases: ${list}`),
      );
    for (const bad of ['["a,b"]', '["my api"]', '["-api"]'])
      expect(withAliases(bad), bad).toMatch(
        /network_aliases\[\] must start with a letter or digit/,
      );
    expect(withAliases("[api, api]")).toMatch(
      /network_aliases: api is listed twice/,
    );
  });
});

describe("resolve and wire — network_aliases on the way out and back", () => {
  it("emits the declared aliases sorted; a silent manifest emits none; [] is a declaration", () => {
    const { desired } = desiredFromManifest(
      checkout(ADMIN.replace("[api]", "[web, api]")),
      "prod",
      {},
    );
    expect(desired[0].fields.network_aliases).toEqual(["api", "web"]);
    const silent = desiredFromManifest(
      checkout(ADMIN.replace("network_aliases: [api]\n", "")),
      "prod",
      {},
    );
    expect(silent.desired[0].fields).not.toHaveProperty("network_aliases");
    const none = desiredFromManifest(
      checkout(ADMIN.replace("[api]", "[]")),
      "prod",
      {},
    );
    expect(none.desired[0].fields.network_aliases).toEqual([]);
  });
  it("applicationApiFields sends Coolify's comma string; [] clears; undeclared sends nothing", () => {
    expect(applicationApiFields({ network_aliases: ["api", "web"] })).toEqual({
      custom_network_aliases: "api,web",
    });
    expect(applicationApiFields({ network_aliases: [] })).toEqual({
      custom_network_aliases: "",
    });
    expect(applicationApiFields({ port: 80 })).not.toHaveProperty(
      "custom_network_aliases",
    );
  });
  it("the read-back parses Coolify's comma string or null into the sorted list; an absent key projects nothing", () => {
    expect(parseNetworkAliases("web,api")).toEqual(["api", "web"]);
    expect(parseNetworkAliases(null)).toEqual([]);
    expect(parseNetworkAliases("")).toEqual([]);
    expect(parseNetworkAliases(["b", "a"])).toEqual(["a", "b"]);
    expect(
      projectLiveFields("application", {
        build_pack: "dockerimage",
        custom_network_aliases: "api",
      }).network_aliases,
    ).toEqual(["api"]);
    expect(
      projectLiveFields("application", {
        build_pack: "dockerimage",
        custom_network_aliases: null,
      }).network_aliases,
    ).toEqual([]);
    expect(
      projectLiveFields("application", { build_pack: "dockerimage" }),
    ).not.toHaveProperty("network_aliases");
  });
});

describe("diff — aliases compared as a set, only when declared", () => {
  const desired = (network_aliases?: string[]) => ({
    kind: "application" as const,
    name: "admin",
    fields: {
      build_pack: "dockerimage",
      docker_registry_image_name: "ghcr.io/acme/admin",
      docker_registry_image_tag: "stable",
      port: 8787,
      domains: [],
      ...(network_aliases ? { network_aliases } : {}),
    },
  });
  const live = (aliases: string | null) => ({
    kind: "application" as const,
    name: "admin",
    uuid: "app-1",
    fields: projectLiveFields("application", {
      build_pack: "dockerimage",
      docker_registry_image_name: "ghcr.io/acme/admin",
      docker_registry_image_tag: "stable",
      ports_exposes: "8787",
      fqdn: "",
      custom_network_aliases: aliases,
    }),
    env: {},
  });
  it("the same aliases in another order are clean", () => {
    expect(
      computeDiff([desired(["api", "web"])], [live("web,api")], "full").clean,
    ).toBe(true);
  });
  it("a missing alias is an updatable field", () => {
    const r = computeDiff([desired(["api"])], [live(null)], "full");
    expect(r.changes[0].fieldDiffs).toEqual([
      { field: "network_aliases", desired: ["api"], live: [], updatable: true },
    ]);
  });
  it("a manifest silent about aliases never diffs on them", () => {
    expect(computeDiff([desired()], [live("anything")], "full").clean).toBe(
      true,
    );
  });
});

describe("draft — a Docker Image application's aliases round-trip (cast#170)", () => {
  const ctx = {
    env: "prod",
    instance: "box-b",
    baseUrl: "https://coolify.example.com",
    team: { id: 0, name: "Root Team" },
    server: "box-b",
    recipient: "age1example",
    generatedAt: "2026-09-25T00:00:00.000Z",
  };
  const raw = (aliases: string | null) => ({
    git_repository: "coollabsio/coolify",
    git_branch: "main",
    build_pack: "dockerimage",
    base_directory: "/",
    docker_registry_image_name: "ghcr.io/acme/admin",
    docker_registry_image_tag: "stable",
    ports_exposes: "8787",
    health_check_path: "/api/health",
    health_check_enabled: true,
    fqdn: "https://admin.example.com",
    custom_network_aliases: aliases,
    destination_id: 3,
  });
  const drafted = (aliases: string | null) => {
    const project: DraftProject = {
      name: "widget",
      coolifyEnv: "prod",
      resources: [
        {
          kind: "application",
          name: "admin",
          uuid: "app-1",
          raw: raw(aliases),
          env: {},
        },
      ],
      unreadable: [],
      otherEnvironments: [],
    };
    const plan = planDraft([project], ctx);
    const file = plan.files.find((f) => f.path.endsWith("manifest.yaml"));
    const dir = tmp("cast-draft-aliases-");
    mkdirSync(join(dir, ".infra"), { recursive: true });
    writeFileSync(join(dir, ".infra", "manifest.yaml"), file?.content ?? "");
    return { dir, m: loadManifest(join(dir, ".infra", "manifest.yaml")) };
  };
  it("emits the aliases, and the drafted manifest loads and re-applies as a no-op", () => {
    const { dir, m } = drafted("web,api");
    expect(m.environments.prod.applications.admin.network_aliases).toEqual([
      "api",
      "web",
    ]);
    const { desired } = desiredFromManifest(dir, "prod", {});
    const liveApp = {
      kind: "application" as const,
      name: "admin",
      uuid: "app-1",
      fields: projectLiveFields("application", raw("web,api")),
      env: {},
    };
    expect(computeDiff(desired, [liveApp], "structural").changes).toEqual([]);
  });
  it("emits nothing for an application with none", () => {
    expect(
      drafted(null).m.environments.prod.applications.admin.network_aliases,
    ).toBeUndefined();
  });
});
