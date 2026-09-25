import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applicationApiFields,
  projectLiveFields,
  projectStorages,
  storageBody,
} from "../src/cli.js";
import { parseApplicationStorages } from "../src/coolify.js";
import { computeDiff, renderDiff } from "../src/diff.js";
import { type DraftProject, planDraft } from "../src/draft.js";
import { loadManifest } from "../src/manifest.js";
import { desiredFromManifest } from "../src/resolve.js";
import { tmp } from "./helpers/tmp.js";

// `storages` on a non-compose application (cast#167): persistent volumes,
// declared in the manifest, created through POST /applications/{uuid}/storages,
// compared by name, and never deleted. Each half is proven here at the unit it
// lives in; storages-cli.test.ts proves the wire through the real binary.

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
// A checkout holding a manifest with this one application, for desiredFromManifest.
const checkout = (app: string) => {
  const dir = tmp("cast-storages-co-");
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
const refusal = (app: string) => {
  try {
    manifest(app);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("the manifest loaded");
};

const ADMIN = `
image: { name: ghcr.io/acme/admin, tag: stable }
build: { pack: dockerimage }
port: 8787
healthcheck: /api/health
domains: []
storages:
  - { name: admin-data, mount_path: /data }
`;

describe("manifest — storages on a non-compose application (cast#167)", () => {
  it("is accepted on dockerimage, nixpacks, dockerfile and static", () => {
    expect(
      manifest(ADMIN).environments.prod.applications.admin.storages,
    ).toEqual([{ name: "admin-data", mount_path: "/data" }]);
    for (const pack of ["nixpacks", "dockerfile", "static"]) {
      const m = manifest(`
source: { repo: acme/admin, branch: main }
build: { pack: ${pack}, base_directory: / }
domains: ["https://admin.example.com"]
storages:
  - { name: admin-data, mount_path: /data, host_path: /srv/admin }
`);
      expect(m.environments.prod.applications.admin.storages, pack).toEqual([
        { name: "admin-data", mount_path: "/data", host_path: "/srv/admin" },
      ]);
    }
  });
  it("is refused on a dockercompose app, naming the compose file", () => {
    expect(
      refusal(`
source: { repo: acme/admin, branch: main }
build: { pack: dockercompose, base_directory: /, compose_file: /docker-compose.yaml }
service_domains: { api: [] }
storages:
  - { name: admin-data, mount_path: /data }
`),
    ).toMatch(/storages not allowed on a dockercompose app .*compose file/);
  });
  it("refuses a bad name, a relative mount_path or host_path, and two entries on one name or path", () => {
    const withStorages = (list: string) =>
      refusal(`${ADMIN.replace(/storages:[\s\S]*$/, "")}storages:\n${list}`);
    expect(withStorages("  - { name: -data, mount_path: /data }")).toMatch(
      /storages\[\]\.name must start with a letter or digit/,
    );
    expect(withStorages("  - { name: my data, mount_path: /data }")).toMatch(
      /storages\[\]\.name/,
    );
    expect(withStorages("  - { name: data, mount_path: data }")).toMatch(
      /storages\[\]\.mount_path must be an absolute path/,
    );
    expect(
      withStorages("  - { name: data, mount_path: /data, host_path: srv }"),
    ).toMatch(/storages\[\]\.host_path must be an absolute path/);
    expect(
      withStorages(
        "  - { name: data, mount_path: /data }\n  - { name: data, mount_path: /other }",
      ),
    ).toMatch(/two entries share name data/);
    expect(
      withStorages(
        "  - { name: a, mount_path: /data }\n  - { name: b, mount_path: /data }",
      ),
    ).toMatch(/two entries share mount_path \/data/);
    expect(withStorages("  - { name: a, mount_path: /d, size: 1 }")).toMatch(
      /Unrecognized key/,
    );
  });
});

describe("resolve and wire — storages ride in the desired fields, never in the application's own body", () => {
  it("emits the declared storages sorted by name, host_path only when given; a silent manifest emits none", () => {
    const { desired: d } = desiredFromManifest(
      checkout(`
image: { name: ghcr.io/acme/admin, tag: stable }
build: { pack: dockerimage }
port: 8787
domains: []
storages:
  - { name: uploads, mount_path: /uploads, host_path: /srv/up }
  - { name: admin-data, mount_path: /data }
`),
      "prod",
      {},
    );
    expect(d[0].fields.storages).toEqual([
      { name: "admin-data", mount_path: "/data" },
      { name: "uploads", mount_path: "/uploads", host_path: "/srv/up" },
    ]);
    const { desired: silent } = desiredFromManifest(
      checkout(ADMIN.replace(/storages:[\s\S]*$/, "")),
      "prod",
      {},
    );
    expect(silent[0].fields).not.toHaveProperty("storages");
  });
  it("applicationApiFields strips storages from a create or PATCH body", () => {
    expect(
      applicationApiFields({
        docker_registry_image_tag: "stable",
        storages: [{ name: "admin-data", mount_path: "/data" }],
      }),
    ).toEqual({ docker_registry_image_tag: "stable" });
  });
  it("a storage create is Coolify's persistent shape, host_path only when declared", () => {
    expect(storageBody({ name: "admin-data", mount_path: "/data" })).toEqual({
      type: "persistent",
      name: "admin-data",
      mount_path: "/data",
    });
    expect(
      storageBody({ name: "a", mount_path: "/a", host_path: "/srv/a" }),
    ).toEqual({
      type: "persistent",
      name: "a",
      mount_path: "/a",
      host_path: "/srv/a",
    });
  });
  it("the read keeps 'could not read' apart from 'none', and the projection drops the uuid prefix Coolify stores", () => {
    expect(parseApplicationStorages(null)).toBeUndefined();
    expect(
      parseApplicationStorages({ persistent_storages: [] }),
    ).toBeUndefined();
    expect(
      parseApplicationStorages({
        persistent_storages: [{ name: "x" }],
        file_storages: [],
      }),
    ).toBeUndefined();
    expect(
      parseApplicationStorages({ persistent_storages: [], file_storages: [] }),
    ).toEqual({ persistent: [], files: [] });
    const read = parseApplicationStorages({
      persistent_storages: [
        {
          uuid: "s1",
          name: "app-1-admin-data",
          mount_path: "/data",
          host_path: null,
        },
        {
          uuid: "s2",
          name: "by-hand",
          mount_path: "/cache",
          host_path: "/srv/c",
        },
      ],
      file_storages: [{ mount_path: "/etc/x.conf" }],
    });
    expect(read?.files).toEqual([{ mount_path: "/etc/x.conf" }]);
    expect(projectStorages("app-1", read?.persistent ?? [])).toEqual([
      { name: "admin-data", mount_path: "/data" },
      { name: "by-hand", mount_path: "/cache", host_path: "/srv/c" },
    ]);
  });
});

describe("diff — storages compared by name; an undeclared one reported and kept; an unreadable read never clean nor drift", () => {
  const desired = (storages: unknown) => ({
    kind: "application" as const,
    name: "admin",
    fields: {
      build_pack: "dockerimage",
      docker_registry_image_name: "ghcr.io/acme/admin",
      docker_registry_image_tag: "stable",
      port: 8787,
      domains: [],
      storages,
    },
  });
  const live = (
    storages:
      | Array<{ name: string; mount_path: string; host_path?: string }>
      | undefined,
    over: Record<string, unknown> = {},
  ) => ({
    kind: "application" as const,
    name: "admin",
    uuid: "app-1",
    fields: {
      ...projectLiveFields("application", {
        build_pack: "dockerimage",
        docker_registry_image_name: "ghcr.io/acme/admin",
        docker_registry_image_tag: "stable",
        ports_exposes: "8787",
        fqdn: "",
      }),
      ...(storages ? { storages } : {}),
    },
    env: {},
    ...over,
  });
  const DATA = [{ name: "admin-data", mount_path: "/data" }];

  it("is clean when every declared storage is live at its path", () => {
    const r = computeDiff([desired(DATA)], [live(DATA)], "full");
    expect(r.clean).toBe(true);
    expect(r.storagesUndeclared).toEqual([]);
  });
  it("a declared storage absent live is drift apply creates", () => {
    const r = computeDiff([desired(DATA)], [live([])], "full");
    expect(r.changes[0].fieldDiffs).toEqual([
      { field: "storages", desired: DATA, live: [], updatable: true },
    ]);
    expect(renderDiff(r)).toContain(
      "storage admin-data: create, mounted at /data",
    );
  });
  it("a changed mount_path or host_path is an update in place, never a recreate", () => {
    const r = computeDiff(
      [desired(DATA)],
      [
        live([
          { name: "admin-data", mount_path: "/var/data", host_path: "/srv" },
        ]),
      ],
      "full",
    );
    expect(r.changes[0].fieldDiffs[0].updatable).toBe(true);
    const out = renderDiff(r);
    expect(out).toContain(
      'storage admin-data: mount_path "/var/data" → "/data"',
    );
    expect(out).toContain('storage admin-data: host_path "/srv" → null');
  });
  it("a live storage the manifest does not declare is reported, counted, and not part of the change", () => {
    const r = computeDiff(
      [desired(DATA)],
      [live([...DATA, { name: "old-cache", mount_path: "/cache" }])],
      "full",
    );
    expect(r.changes).toEqual([]);
    expect(r.storagesUndeclared).toEqual([
      {
        name: "admin",
        storages: [{ name: "old-cache", mount_path: "/cache" }],
      },
    ]);
    expect(r.clean).toBe(false);
    const out = renderDiff(r);
    expect(out).toContain(
      "undeclared storage old-cache on application admin (mounted at /cache) — apply never deletes a volume",
    );
    expect(out).toContain("1 undeclared storage(s)");
  });
  it("an unreadable read is 'not compared': no drift, no clean bill of the storages, a line on the report", () => {
    const r = computeDiff(
      [desired(DATA)],
      [
        live(undefined, {
          storagesNotCompared:
            "GET /applications/{uuid}/storages was unreachable",
        }),
      ],
      "full",
    );
    expect(r.changes).toEqual([]);
    expect(r.storagesNotCompared).toEqual([
      {
        name: "admin",
        reason: "GET /applications/{uuid}/storages was unreachable",
      },
    ]);
    expect(renderDiff(r)).toContain(
      "storages on application admin declared, NOT compared — verify in the Coolify UI",
    );
  });
  it("a manifest silent about storages compares none, whatever the box holds", () => {
    const { storages: _s, ...fields } = desired(DATA).fields;
    const r = computeDiff(
      [{ ...desired(DATA), fields }],
      [live([{ name: "anything", mount_path: "/x" }])],
      "full",
    );
    expect(r.clean).toBe(true);
    expect(r.storagesUndeclared).toEqual([]);
  });
  it("on a create, each declared storage is a line", () => {
    const r = computeDiff([desired(DATA)], [], "full");
    expect(renderDiff(r)).toContain(
      "storage admin-data: create, mounted at /data",
    );
  });
});

describe("draft — a Docker Image application's persistent storage round-trips (cast#167)", () => {
  const ctx = {
    env: "prod",
    instance: "box-b",
    baseUrl: "https://coolify.example.com",
    team: { id: 0, name: "Root Team" },
    server: "box-b",
    recipient: "age1example",
    generatedAt: "2026-09-25T00:00:00.000Z",
  };
  const raw = {
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
    destination_id: 3,
  };
  const project = (
    storages: DraftProject["resources"][number]["storages"],
  ): DraftProject => ({
    name: "widget",
    coolifyEnv: "prod",
    resources: [
      {
        kind: "application",
        name: "admin",
        uuid: "app-1",
        raw,
        env: {},
        storages,
      },
    ],
    unreadable: [],
    otherEnvironments: [],
  });
  const drafted = (storages: DraftProject["resources"][number]["storages"]) => {
    const plan = planDraft([project(storages)], ctx);
    const file = plan.files.find((f) => f.path.endsWith("manifest.yaml"));
    const dir = tmp("cast-draft-storages-");
    mkdirSync(join(dir, ".infra"), { recursive: true });
    const path = join(dir, ".infra", "manifest.yaml");
    writeFileSync(path, file?.content ?? "");
    return { m: loadManifest(path), plan, dir };
  };
  const persistent = [
    {
      uuid: "s1",
      name: "app-1-admin-data",
      mount_path: "/data",
      host_path: null,
    },
  ];

  it("emits the storage, and the drafted manifest loads and re-applies as a no-op", () => {
    const { m, plan, dir } = drafted({
      persistent: projectStorages("app-1", persistent),
      files: [],
    });
    expect(m.environments.prod.applications.admin.storages).toEqual([
      { name: "admin-data", mount_path: "/data" },
    ]);
    expect(plan.uncaptured.filter((u) => u.resource === "admin")).toEqual([]);
    const { desired } = desiredFromManifest(dir, "prod", {});
    const liveApp = {
      kind: "application" as const,
      name: "admin",
      uuid: "app-1",
      fields: {
        ...projectLiveFields("application", raw),
        storages: projectStorages("app-1", persistent),
      },
      env: {},
    };
    const r = computeDiff(desired, [liveApp], "structural");
    expect(r.changes).toEqual([]);
    expect(r.storagesUndeclared).toEqual([]);
  });
  it("names a file storage and an unreadable read in UNCAPTURED.md, and still loads", () => {
    const files = drafted({
      persistent: [],
      files: [{ mount_path: "/etc/app.conf" }],
    });
    expect(
      files.m.environments.prod.applications.admin.storages,
    ).toBeUndefined();
    expect(
      files.plan.uncaptured.find((u) => u.setting === "file storage")?.detail,
    ).toContain("/etc/app.conf");
    const unread = drafted("unreadable");
    expect(
      unread.plan.uncaptured.find((u) => u.setting === "storages")?.detail,
    ).toMatch(/NOT in this draft/);
  });
});
