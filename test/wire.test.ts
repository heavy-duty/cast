import { describe, expect, it, vi } from "vitest";
import {
  applicationApiFields,
  buildExecutor,
  databaseApiFields,
  databaseVersionFromImage,
  defaultDatabaseImage,
  parseDockerComposeDomains,
  projectLiveFields,
  serviceApiFields,
} from "../src/cli.js";
import { CoolifyClient } from "../src/coolify.js";
import { computeDiff } from "../src/diff.js";
import { DERIVED_UNRESOLVED } from "../src/envtemplate.js";

// Pure wire-translation helpers (Desired vocabulary <-> Coolify API
// vocabulary). Importing src/cli.ts here must not run the CLI — see the
// import.meta.url guard around main() at the bottom of that file.

describe("applicationApiFields", () => {
  it("joins domains into a comma-separated string and renames port/healthcheck", () => {
    const out = applicationApiFields({
      port: 3000,
      healthcheck: "/health",
      domains: ["https://a.example.com", "https://b.example.com"],
    });
    expect(out).toEqual({
      ports_exposes: "3000",
      health_check_path: "/health",
      domains: "https://a.example.com,https://b.example.com",
    });
  });
  it("maps a docker_compose_domains map to the wire array-of-{name,domain} shape", () => {
    const out = applicationApiFields({
      docker_compose_domains: {
        api: ["https://a", "https://b"],
        admin: ["https://c"],
      },
    });
    expect(out).toEqual({
      docker_compose_domains: [
        { name: "api", domain: "https://a,https://b" },
        { name: "admin", domain: "https://c" },
      ],
    });
  });
});

describe("databaseApiFields", () => {
  it("maps type+version to an image and drops the type/version keys", () => {
    const out = databaseApiFields({ type: "postgresql", version: "17" });
    expect(out).toEqual({ image: "postgres:17-alpine" });
    expect(out).not.toHaveProperty("type");
    expect(out).not.toHaveProperty("version");
  });
});

describe("serviceApiFields", () => {
  // cast#72: a service's per-container hostnames go on the wire as `urls`
  // ({name, url}[], url comma-joined) — matched to a ServiceApplication by name
  // on create/PATCH. `service_domains` is the internal map that becomes it.
  it("builds `urls` from service_domains", () => {
    const out = serviceApiFields({
      type: "plausible",
      service_domains: {
        web: ["https://stats.example.com", "https://alt.example.com"],
        collector: ["https://collect.example.com"],
      },
    });
    expect(out).toEqual({
      type: "plausible",
      urls: [
        {
          name: "web",
          url: "https://stats.example.com,https://alt.example.com",
        },
        { name: "collector", url: "https://collect.example.com" },
      ],
    });
    expect(out).not.toHaveProperty("service_domains");
  });
  it("sends no `urls` for a service with no service_domains", () => {
    const out = serviceApiFields({ type: "plausible" });
    expect(out).toEqual({ type: "plausible" });
    expect(out).not.toHaveProperty("urls");
  });
});

describe("parseDockerComposeDomains", () => {
  // cast#68: the REAL read shape on a live Coolify 4.1.2 — a service-keyed
  // object, NOT the array the OpenAPI implies. This exact string came off the
  // wire. It must decode into cast's internal { service: string[] } map.
  it("parses the real service-keyed object shape", () => {
    const raw =
      '{"api":{"domain":"https://api.heavyduty.builders"},"admin":{"domain":"https://admin.heavyduty.builders"},"intake":{"domain":"https://apply.heavyduty.builders"}}';
    expect(parseDockerComposeDomains(raw)).toEqual({
      api: ["https://api.heavyduty.builders"],
      admin: ["https://admin.heavyduty.builders"],
      intake: ["https://apply.heavyduty.builders"],
    });
  });

  it("splits a comma-joined domain string into the internal array", () => {
    const raw =
      '{"api":{"domain":"https://a.example.com,https://b.example.com"}}';
    expect(parseDockerComposeDomains(raw)).toEqual({
      api: ["https://a.example.com", "https://b.example.com"],
    });
  });

  // The write side (applicationApiFields) still emits the array shape, and the
  // vendored OpenAPI documents it — keep tolerating it so the round-trip holds.
  it("still parses the legacy array-of-{name,domain} shape", () => {
    const raw = '[{"name":"api","domain":"https://api.example.com"}]';
    expect(parseDockerComposeDomains(raw)).toEqual({
      api: ["https://api.example.com"],
    });
  });

  it("collapses a malformed string to undefined rather than throwing", () => {
    expect(parseDockerComposeDomains("not json{")).toBeUndefined();
    // A JSON scalar is neither shape.
    expect(parseDockerComposeDomains("42")).toBeUndefined();
    expect(parseDockerComposeDomains("")).toBeUndefined();
    expect(parseDockerComposeDomains(null)).toBeUndefined();
  });
});

describe("projectLiveFields", () => {
  it("projects a live application onto the Desired vocabulary", () => {
    const out = projectLiveFields("application", {
      git_repository: "org/repo",
      git_branch: "main",
      build_pack: "nixpacks",
      base_directory: "/",
      ports_exposes: "3000",
      health_check_path: "/health",
      fqdn: "https://a.example.com,https://b.example.com",
    });
    expect(out.domains).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
    expect(out.port).toBe(3000);
    expect(out.healthcheck).toBe("/health");
  });

  it("normalizes a live database's database_type to the manifest vocabulary", () => {
    const out = projectLiveFields("database", {
      database_type: "standalone-postgresql",
      image: "postgres:17-alpine",
    });
    expect(out).toEqual({ type: "postgresql", version: "17" });
  });

  it("projects both docker_compose_location and docker_compose_domains for a live compose app", () => {
    const out = projectLiveFields("application", {
      git_repository: "org/repo",
      git_branch: "main",
      build_pack: "dockercompose",
      base_directory: "/",
      docker_compose_location: "docker-compose.yaml",
      docker_compose_domains: JSON.stringify([
        { name: "api", domain: "https://api.widget.example.com" },
      ]),
    });
    expect(out.docker_compose_location).toBe("docker-compose.yaml");
    expect(out.docker_compose_domains).toEqual({
      api: ["https://api.widget.example.com"],
    });
  });

  it("does not choke on an absent/null docker_compose_domains", () => {
    const out = projectLiveFields("application", {
      git_repository: "org/repo",
      git_branch: "main",
      build_pack: "dockercompose",
      base_directory: "/",
      docker_compose_location: "docker-compose.yaml",
      docker_compose_domains: null,
    });
    expect(out).not.toHaveProperty("docker_compose_domains");
  });

  // #63: the static-site fields must read back off a live application so they
  // diff against the manifest — otherwise a UI flip of is_static is invisible.
  it("reads is_static and the build/run commands off a live application", () => {
    const out = projectLiveFields("application", {
      git_repository: "org/repo",
      git_branch: "main",
      build_pack: "static",
      base_directory: "/",
      is_static: true,
      install_command: "npm ci",
      build_command: "npm run build -w apps/landing-site",
      start_command: "node server.js",
    });
    expect(out.is_static).toBe(true);
    expect(out.install_command).toBe("npm ci");
    expect(out.build_command).toBe("npm run build -w apps/landing-site");
    expect(out.start_command).toBe("node server.js");
  });

  it("reports a readable is_static as a boolean, tolerating Coolify's 1/0", () => {
    expect(projectLiveFields("application", { is_static: 1 }).is_static).toBe(
      true,
    );
    expect(projectLiveFields("application", { is_static: 0 }).is_static).toBe(
      false,
    );
    // A real `false` is readable and projected as false, so a UI flip off
    // `static` still diffs against a manifest that declares `static: true`.
    expect(
      projectLiveFields("application", { is_static: false }).is_static,
    ).toBe(false);
  });

  // cast#68: Coolify 4.1.2 returns is_static: null on the read path even for a
  // genuinely-static app. An unreadable value must be OMITTED, not projected as
  // `false` — projecting false diffed false→true and redeployed every run.
  it("omits is_static when the live value is unreadable (null/absent)", () => {
    expect(
      projectLiveFields("application", { is_static: null }),
    ).not.toHaveProperty("is_static");
    // Absent on the wire is the same unreadable case, not a real `false`.
    expect(projectLiveFields("application", {})).not.toHaveProperty(
      "is_static",
    );
  });
});

describe("compose app idempotency (review finding #2)", () => {
  it("produces zero field diffs when live docker_compose_location/domains match the manifest", () => {
    const desired = [
      {
        kind: "application" as const,
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
      },
    ];
    const liveRaw = {
      git_repository: "acme/widget",
      git_branch: "main",
      build_pack: "dockercompose",
      base_directory: "/",
      docker_compose_location: "docker-compose.yaml",
      docker_compose_domains: JSON.stringify([
        { name: "api", domain: "https://api.widget.example.com" },
      ]),
    };
    const live = [
      {
        kind: "application" as const,
        name: "core",
        uuid: "app-uuid",
        fields: projectLiveFields("application", liveRaw),
      },
    ];
    const report = computeDiff(desired, live, "structural");
    expect(report.clean).toBe(true);
  });

  // cast#68: the idempotency guarantee against the REAL live shape. When
  // docker_compose_domains comes back as Coolify 4.1.2's service-keyed object
  // string, a matching manifest must still produce ZERO field diff — before the
  // fix the object bailed to undefined and cast diffed the map against nothing
  // on every apply.
  it("produces zero field diffs when live docker_compose_domains is the service-keyed object shape", () => {
    const desired = [
      {
        kind: "application" as const,
        name: "core",
        fields: {
          git_repository: "acme/widget",
          git_branch: "main",
          build_pack: "dockercompose",
          base_directory: "/",
          docker_compose_location: "docker-compose.yaml",
          docker_compose_domains: {
            api: ["https://api.heavyduty.builders"],
            admin: ["https://admin.heavyduty.builders"],
          },
        },
      },
    ];
    const liveRaw = {
      git_repository: "acme/widget",
      git_branch: "main",
      build_pack: "dockercompose",
      base_directory: "/",
      docker_compose_location: "docker-compose.yaml",
      docker_compose_domains:
        '{"api":{"domain":"https://api.heavyduty.builders"},"admin":{"domain":"https://admin.heavyduty.builders"}}',
    };
    const live = [
      {
        kind: "application" as const,
        name: "core",
        uuid: "app-uuid",
        fields: projectLiveFields("application", liveRaw),
      },
    ];
    const report = computeDiff(desired, live, "structural");
    expect(report.clean).toBe(true);
  });
});

// cast#68: is_static is unreadable on Coolify 4.1.2's read path (returns null
// even for a static app). A manifest that declares `static: true` must NOT diff
// against that null forever — the comparison is skipped and a once-per-run warn
// is emitted. A real live boolean still diffs normally.
describe("is_static live-unreadable degradation (cast#68)", () => {
  const baseFields = {
    git_repository: "acme/site",
    git_branch: "main",
    build_pack: "static",
    base_directory: "/",
  };

  it("does not diff is_static when the live value is unreadable, and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const desired = [
      {
        kind: "application" as const,
        name: "landing",
        fields: { ...baseFields, is_static: true },
      },
    ];
    // projectLiveFields omits is_static from a null live read; fetchLive flags
    // the resource staticNotCompared (mirrored here).
    const liveFields = projectLiveFields("application", {
      ...baseFields,
      is_static: null,
    });
    expect(liveFields).not.toHaveProperty("is_static");
    const live = [
      {
        kind: "application" as const,
        name: "landing",
        uuid: "app-uuid",
        fields: liveFields,
        staticNotCompared: true,
      },
    ];
    const report = computeDiff(desired, live, "structural");
    const change = report.changes.find((c) => c.name === "landing");
    expect(change?.fieldDiffs.some((f) => f.field === "is_static")).toBeFalsy();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("still diffs is_static when the live value is a real boolean", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const desired = [
      {
        kind: "application" as const,
        name: "landing",
        fields: { ...baseFields, is_static: true },
      },
    ];
    // A UI flip off static: the live value is a genuine `false`, readable and
    // staticNotCompared unset — cast must catch the drift, not suppress it.
    const live = [
      {
        kind: "application" as const,
        name: "landing",
        uuid: "app-uuid",
        fields: projectLiveFields("application", {
          ...baseFields,
          is_static: false,
        }),
      },
    ];
    const report = computeDiff(desired, live, "structural");
    const change = report.changes.find((c) => c.name === "landing");
    const staticDiff = change?.fieldDiffs.find((f) => f.field === "is_static");
    expect(staticDiff).toBeDefined();
    expect(staticDiff?.desired).toBe(true);
    expect(staticDiff?.live).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("buildExecutor createResource (application, dockercompose)", () => {
  function mockFetch(handler: (path: string, init?: RequestInit) => Response) {
    return vi.fn(async (url: string | URL, init?: RequestInit) =>
      handler(new URL(String(url)).pathname, init),
    ) as unknown as typeof fetch;
  }

  it("sets connect_to_docker_network: true on a compose app create payload", async () => {
    let createBody: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((path, init) => {
      if (path === "/api/v1/projects" && (!init || init.method === "GET"))
        return new Response(
          JSON.stringify([{ uuid: "proj-1", name: "widget" }]),
          { status: 200 },
        );
      if (path === "/api/v1/projects/proj-1/environments")
        return new Response(JSON.stringify([{ name: "prod" }]), {
          status: 200,
        });
      if (path === "/api/v1/applications/private-github-app") {
        createBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ uuid: "app-1" }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const client = new CoolifyClient("https://coolify.test", "tok", fetchImpl);
    const exec = buildExecutor(client, {
      projectName: "widget",
      envName: "prod",
      serverUuid: "srv-1",
      githubAppUuid: "gh-1",
      serverName: "prod-box",
      orgRepo: "acme/widget",
      bindingEnv: "prod",
    });
    const uuid = await exec.createResource({
      kind: "application",
      name: "core",
      op: "create",
      fieldDiffs: [
        { field: "build_pack", desired: "dockercompose", updatable: false },
        {
          field: "docker_compose_location",
          desired: "docker-compose.yaml",
          updatable: true,
        },
        {
          field: "docker_compose_domains",
          desired: { api: ["https://api.widget.example.com"] },
          updatable: true,
        },
      ],
      envDiffs: [],
    });
    expect(uuid).toBe("app-1");
    expect(createBody?.connect_to_docker_network).toBe(true);
    expect(createBody?.docker_compose_domains).toEqual([
      { name: "api", domain: "https://api.widget.example.com" },
    ]);
  });

  it("does not set connect_to_docker_network for a non-compose app", async () => {
    let createBody: Record<string, unknown> | undefined;
    const fetchImpl = mockFetch((path, init) => {
      if (path === "/api/v1/projects" && (!init || init.method === "GET"))
        return new Response(
          JSON.stringify([{ uuid: "proj-1", name: "widget" }]),
          { status: 200 },
        );
      if (path === "/api/v1/projects/proj-1/environments")
        return new Response(JSON.stringify([{ name: "prod" }]), {
          status: 200,
        });
      if (path === "/api/v1/applications/private-github-app") {
        createBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ uuid: "app-2" }), {
          status: 200,
        });
      }
      return new Response("not found", { status: 404 });
    });
    const client = new CoolifyClient("https://coolify.test", "tok", fetchImpl);
    const exec = buildExecutor(client, {
      projectName: "widget",
      envName: "prod",
      serverUuid: "srv-1",
      githubAppUuid: "gh-1",
      serverName: "prod-box",
      orgRepo: "acme/widget",
      bindingEnv: "prod",
    });
    await exec.createResource({
      kind: "application",
      name: "core-api",
      op: "create",
      fieldDiffs: [
        { field: "build_pack", desired: "nixpacks", updatable: false },
        { field: "domains", desired: ["https://a"], updatable: true },
      ],
      envDiffs: [],
    });
    expect(createBody).not.toHaveProperty("connect_to_docker_network");
  });
});

// Placement is create-time only, and every kind needs it: Coolify runs the same
// destination logic in ApplicationsController, DatabasesController and
// ServicesController, and 400s on a multi-destination server for whichever one
// omits it. Missing it on the database create alone would be enough to leave a
// project's Postgres on the shared default network.
describe("buildExecutor createResource (destination placement)", () => {
  function captureCreates() {
    const bodies: Record<string, Record<string, unknown>> = {};
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/projects" && (!init || init.method === "GET"))
        return new Response(
          JSON.stringify([{ uuid: "proj-1", name: "widget" }]),
          { status: 200 },
        );
      // The environment a create names has to exist, so apply reads it first
      // (#38). This project is an existing one and already carries `prod`.
      if (path === "/api/v1/projects/proj-1/environments")
        return new Response(JSON.stringify([{ name: "prod" }]), {
          status: 200,
        });
      if (
        path === "/api/v1/applications/private-github-app" ||
        path === "/api/v1/databases/postgresql" ||
        path === "/api/v1/services"
      ) {
        bodies[path] = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ uuid: "new-1" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { bodies, fetchImpl };
  }

  const creates = [
    {
      path: "/api/v1/applications/private-github-app",
      change: {
        kind: "application" as const,
        name: "core",
        op: "create" as const,
        fieldDiffs: [
          { field: "build_pack", desired: "nixpacks", updatable: false },
          { field: "domains", desired: ["https://a"], updatable: true },
        ],
        envDiffs: [],
      },
    },
    {
      path: "/api/v1/databases/postgresql",
      change: {
        kind: "database" as const,
        name: "postgres",
        op: "create" as const,
        fieldDiffs: [
          { field: "type", desired: "postgresql", updatable: false },
        ],
        envDiffs: [],
      },
    },
    {
      path: "/api/v1/services",
      change: {
        kind: "service" as const,
        name: "umami",
        op: "create" as const,
        fieldDiffs: [{ field: "type", desired: "umami", updatable: false }],
        envDiffs: [],
      },
    },
  ];

  it.each(creates)(
    "sends destination_uuid on the $path create",
    async ({ path, change }) => {
      const { bodies, fetchImpl } = captureCreates();
      const client = new CoolifyClient(
        "https://coolify.test",
        "tok",
        fetchImpl,
      );
      const exec = buildExecutor(client, {
        projectName: "widget",
        envName: "prod",
        serverUuid: "srv-1",
        githubAppUuid: "gh-1",
        serverName: "prod-box",
        orgRepo: "acme/widget",
        bindingEnv: "prod",
        destinationUuid: "dest-abc",
      });
      await exec.createResource(change);
      expect(bodies[path]?.destination_uuid).toBe("dest-abc");
      // The server still has to be named — a destination belongs to one.
      expect(bodies[path]?.server_uuid).toBe("srv-1");
    },
  );

  // Undeclared must mean ABSENT, not empty-string: Coolify branches on
  // `$request->has('destination_uuid')`, so sending "" would take the
  // "you gave me one" path and then fail to match any destination.
  it.each(creates)(
    "omits destination_uuid entirely when none is declared ($path)",
    async ({ path, change }) => {
      const { bodies, fetchImpl } = captureCreates();
      const client = new CoolifyClient(
        "https://coolify.test",
        "tok",
        fetchImpl,
      );
      const exec = buildExecutor(client, {
        projectName: "widget",
        envName: "prod",
        serverUuid: "srv-1",
        githubAppUuid: "gh-1",
        serverName: "prod-box",
        orgRepo: "acme/widget",
        bindingEnv: "prod",
      });
      await exec.createResource(change);
      expect(bodies[path]).not.toHaveProperty("destination_uuid");
    },
  );
});

// #38: the first apply against a project that does not exist yet. POST /projects
// hands the new project Coolify's OWN default environment ("production"), never
// ours — so a create that names `environment_name: prod` 404s with "Environment
// not found" and leaves the project behind, created and empty. Every environment
// cast had touched until then was hand-built in a UI and adopted, which is why
// the from-nothing path is the one that had never run.
describe("buildExecutor createResource (environment reconcile)", () => {
  // A Coolify with ONE project's worth of state, driven by what the test hands
  // it: `projects` is what GET /projects answers, `environments` what the
  // project carries. Both mutate as cast writes, so the mock stays honest about
  // what a second read would see.
  function fakeCoolify(opts: {
    projects?: Array<{ uuid: string; name: string }>;
    environments?: string[];
    envCreateStatus?: number;
    // What an environment HOLDS, by name — the guard on #40's delete. A project
    // cast just created cannot really hold anything, which is exactly why the
    // mock has to be able to say otherwise: the guard is worth only as much as
    // the case it refuses.
    holds?: Record<string, unknown[]>;
    envDeleteStatus?: number;
  }) {
    const projects = opts.projects ?? [];
    let environments = opts.environments ?? [];
    const holds = opts.holds ?? {};
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (path === "/api/v1/projects" && method === "GET")
        return new Response(JSON.stringify(projects), { status: 200 });
      if (path === "/api/v1/projects" && method === "POST") {
        projects.push({ uuid: "proj-new", name: "widget" });
        // Coolify's doing, not ours: a brand-new project comes with this.
        environments = ["production"];
        return new Response(JSON.stringify({ uuid: "proj-new" }), {
          status: 201,
        });
      }
      const envRoute = /^\/api\/v1\/projects\/([^/]+)\/environments$/.exec(
        path,
      );
      if (envRoute && method === "GET")
        return new Response(
          JSON.stringify(environments.map((name) => ({ name }))),
          { status: 200 },
        );
      // CoolifyClient.environments falls back to the project show route when
      // the list route answers empty — it carries the same names as a relation.
      if (/^\/api\/v1\/projects\/[^/]+$/.test(path) && method === "GET")
        return new Response(
          JSON.stringify({
            environments: environments.map((name) => ({ name })),
          }),
          { status: 200 },
        );
      if (envRoute && method === "POST") {
        const name = JSON.parse(String(init?.body)).name as string;
        const status = opts.envCreateStatus ?? 201;
        if (status === 409) {
          // A 409 is Coolify saying the name is TAKEN — so in the world the
          // mock is modelling it exists, created by whoever won the race
          // between our read and our write. The environment is there; only our
          // create lost. A 409 whose environment did not exist is not a state
          // Coolify can be in, and pretending otherwise would test nothing.
          if (!environments.includes(name)) environments.push(name);
          return new Response(
            JSON.stringify({
              message: "Environment with this name already exists.",
            }),
            { status: 409 },
          );
        }
        if (status !== 201)
          return new Response(JSON.stringify({ message: "boom" }), { status });
        environments.push(name);
        return new Response(JSON.stringify({ uuid: "env-1" }), { status: 201 });
      }
      // DELETE /projects/{uuid}/environments/{name} — #40. Three segments, so the
      // two-segment details route below cannot swallow it.
      const envDelete =
        /^\/api\/v1\/projects\/([^/]+)\/environments\/([^/]+)$/.exec(path);
      if (envDelete && method === "DELETE") {
        const status = opts.envDeleteStatus ?? 200;
        if (status !== 200)
          return new Response(JSON.stringify({ message: "boom" }), { status });
        environments = environments.filter((e) => e !== envDelete[2]);
        return new Response(
          JSON.stringify({ message: "Environment deleted." }),
          { status: 200 },
        );
      }
      // GET /projects/{uuid}/{environment} — the details route, the ONLY one that
      // eager-loads an environment's resources, and so the only one that can
      // answer "is it empty?". The list route's Environment objects carry no
      // relations at all. Checked after the /environments routes above, which
      // this pattern would otherwise match.
      const envDetail = /^\/api\/v1\/projects\/([^/]+)\/([^/]+)$/.exec(path);
      if (envDetail && method === "GET") {
        const name = envDetail[2];
        if (!environments.includes(name))
          return new Response(JSON.stringify({ message: "Not found." }), {
            status: 404,
          });
        return new Response(
          JSON.stringify({
            id: 1,
            name,
            project_id: 1,
            description: "",
            applications: holds[name] ?? [],
            postgresqls: [],
            redis: [],
            services: [],
          }),
          { status: 200 },
        );
      }
      if (path === "/api/v1/applications/private-github-app") {
        // Coolify's actual rule, and the whole of #38: a create names an
        // environment, and an environment that is not there is a 404. Without
        // it this mock would happily accept the create that a real box refuses,
        // and the test below would pass against the very bug it exists to catch.
        const body = JSON.parse(String(init?.body)) as {
          environment_name: string;
        };
        if (!environments.includes(body.environment_name))
          return new Response(
            JSON.stringify({ message: "Environment not found." }),
            { status: 404 },
          );
        return new Response(JSON.stringify({ uuid: "app-1" }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl, environments: () => environments };
  }

  const app = {
    kind: "application" as const,
    name: "core",
    op: "create" as const,
    fieldDiffs: [
      { field: "build_pack", desired: "nixpacks", updatable: false },
    ],
    envDiffs: [],
  };

  // envName is a parameter because #40's third guard is about it: an environment
  // named `production` is Coolify's leftover default in every run EXCEPT the one
  // that asked for `--environment production`, where it is the environment
  // everything is about to live in.
  function exec(fetchImpl: typeof fetch, envName = "prod") {
    return buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      {
        projectName: "widget",
        envName,
        serverUuid: "srv-1",
        githubAppUuid: "gh-1",
        serverName: "prod-box",
        orgRepo: "acme/widget",
        bindingEnv: "prod",
      },
    );
  }

  it("creates the environment on a project it just created, and the create names it", async () => {
    const coolify = fakeCoolify({ projects: [] });
    const uuid = await exec(coolify.fetchImpl).createResource(app);

    expect(uuid).toBe("app-1");
    // The fix: our environment is created BEFORE the resource that names it.
    expect(coolify.calls).toContain(
      "POST /api/v1/projects/proj-new/environments",
    );
    expect(coolify.environments()).toContain("prod");
    const order = coolify.calls.indexOf(
      "POST /api/v1/projects/proj-new/environments",
    );
    const create = coolify.calls.indexOf(
      "POST /api/v1/applications/private-github-app",
    );
    expect(order).toBeGreaterThan(-1);
    expect(order).toBeLessThan(create);
  });

  // The half of idempotence that protects every apply that works today: an
  // environment that already exists must not be written to at all.
  it("never touches the create route when the environment already exists", async () => {
    const coolify = fakeCoolify({
      projects: [{ uuid: "proj-1", name: "widget" }],
      environments: ["prod", "staging"],
    });
    await exec(coolify.fetchImpl).createResource(app);

    expect(coolify.calls).toContain("GET /api/v1/projects/proj-1/environments");
    expect(coolify.calls).not.toContain(
      "POST /api/v1/projects/proj-1/environments",
    );
  });

  // Coolify 409s a duplicate environment name — the same answer as "present",
  // reached when something else wins the race between our read and our write.
  it("treats a 409 from the environment create as already-there", async () => {
    const coolify = fakeCoolify({
      projects: [{ uuid: "proj-1", name: "widget" }],
      environments: [],
      envCreateStatus: 409,
    });
    const uuid = await exec(coolify.fetchImpl).createResource(app);
    expect(uuid).toBe("app-1");
  });

  // A 5xx is NOT "already there" — apply must not go on to create resources
  // into an environment it has no reason to believe exists.
  it("surfaces a non-409 failure from the environment create", async () => {
    const coolify = fakeCoolify({
      projects: [{ uuid: "proj-1", name: "widget" }],
      environments: [],
      envCreateStatus: 500,
    });
    await expect(exec(coolify.fetchImpl).createResource(app)).rejects.toThrow(
      /environments → 500/,
    );
  });

  // Five creates in a run must reconcile the project and its environment once,
  // not five times.
  it("reconciles once across several creates", async () => {
    const coolify = fakeCoolify({ projects: [] });
    const e = exec(coolify.fetchImpl);
    await e.createResource(app);
    await e.createResource({ ...app, name: "core-api" });

    const envReads = coolify.calls.filter((c) => c.endsWith("/environments"));
    expect(envReads).toHaveLength(2); // one GET + one POST, not two of each
    expect(
      coolify.calls.filter((c) => c === "POST /api/v1/projects").length,
    ).toBe(1);
  });

  // #40: what #39 left behind. POST /projects hands the new project Coolify's own
  // default environment, and #39 then created OURS beside it — so every project cast
  // creates from nothing carried a permanently-empty `production` next to the
  // environment everything actually lives in. That is the shape that makes a box
  // unreadable later; the box being migrated away from has an empty `production` and
  // runs everything in `staging`, and "the obvious guess is the wrong one" is a note
  // we had to write for ourselves.
  //
  // This is also the ONE delete cast performs, so the guards are the test: it happens
  // only to a project cast made in this run, only to an environment that is empty, and
  // only when the name is not the one we asked for.
  describe("buildExecutor createResource (default environment removal, #40)", () => {
    const DELETE_DEFAULT =
      "DELETE /api/v1/projects/proj-new/environments/production";

    it("removes the empty default environment from a project it just created", async () => {
      const coolify = fakeCoolify({ projects: [] });
      const notes = vi.spyOn(console, "log").mockImplementation(() => {});

      const uuid = await exec(coolify.fetchImpl).createResource(app);

      expect(uuid).toBe("app-1");
      expect(coolify.calls).toContain(DELETE_DEFAULT);
      // The point of the whole issue: what is left is ours, and only ours.
      expect(coolify.environments()).toEqual(["prod"]);
      expect(notes.mock.calls.flat().join("\n")).toMatch(
        /removed Coolify's default environment production/,
      );
      notes.mockRestore();
    });

    // Guard 1. The rule cast does not get to break: a project someone built by hand
    // is not cast's to tidy, whatever it happens to carry. `production` sitting empty
    // next to `staging` on an ADOPTED project is exactly the live box we migrate from
    // — and it stays untouched.
    it("never removes an environment from a project it adopted", async () => {
      const coolify = fakeCoolify({
        projects: [{ uuid: "proj-1", name: "widget" }],
        environments: ["production", "prod"],
      });

      await exec(coolify.fetchImpl).createResource(app);

      expect(coolify.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
      expect(coolify.environments()).toContain("production");
    });

    // Guard 2. Asked of Coolify, not inferred from "we just made this project". The
    // mock is lying here — a fresh project cannot hold an application — and it must
    // be able to, because a guard that is only ever handed the safe case is not a
    // guard. cast declines, and says why.
    it("leaves the default environment alone when it holds anything", async () => {
      const coolify = fakeCoolify({
        projects: [],
        holds: { production: [{ uuid: "app-x", name: "legacy" }] },
      });
      const notes = vi.spyOn(console, "log").mockImplementation(() => {});

      await exec(coolify.fetchImpl).createResource(app);

      expect(coolify.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
      expect(coolify.environments()).toContain("production");
      expect(notes.mock.calls.flat().join("\n")).toMatch(
        /left Coolify's default environment production .* NOT empty/,
      );
      notes.mockRestore();
    });

    // Guard 3. `production` is a leftover in every run except the one that asked for
    // it, where it is the environment everything is about to live in. Deleting it
    // there would delete the target of the very apply doing the deleting.
    it("keeps the default environment when it is the one we asked for", async () => {
      const coolify = fakeCoolify({ projects: [] });

      await exec(coolify.fetchImpl, "production").createResource(app);

      expect(coolify.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
      expect(coolify.environments()).toEqual(["production"]);
      // ...and it was never re-created either: it was already there.
      expect(coolify.calls).not.toContain(
        "POST /api/v1/projects/proj-new/environments",
      );
    });

    // Tidying is a courtesy, and a courtesy that can fail an apply is not one. The
    // resource still gets created; the operator is told what was left behind.
    it("does not fail the apply when the delete fails", async () => {
      const coolify = fakeCoolify({ projects: [], envDeleteStatus: 500 });
      const notes = vi.spyOn(console, "log").mockImplementation(() => {});

      const uuid = await exec(coolify.fetchImpl).createResource(app);

      expect(uuid).toBe("app-1");
      expect(coolify.environments()).toContain("production");
      expect(notes.mock.calls.flat().join("\n")).toMatch(
        /could not remove it .*500/s,
      );
      notes.mockRestore();
    });
  });
});

// #41: a first apply against a server with more than one destination 400s on the
// first create — with the project and the environment already made. Coolify's own
// message names neither the remedy nor the file it goes in, and cast cannot
// pre-flight the condition (4.1.2 serves no destinations API at all, so a server's
// destination count is unknowable until a create has been attempted). The diagnosis
// is the whole of what is fixable, so the diagnosis is what is tested.
describe("buildExecutor createResource (multi-destination 400, #41)", () => {
  const app = {
    kind: "application" as const,
    name: "core",
    op: "create" as const,
    fieldDiffs: [
      { field: "build_pack", desired: "nixpacks", updatable: false },
    ],
    envDiffs: [],
  };

  // Coolify's real answer, verbatim, from all three create controllers.
  function multiDestinationCoolify() {
    return vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/v1/projects" && method === "GET")
        return new Response(
          JSON.stringify([{ uuid: "proj-1", name: "widget" }]),
          { status: 200 },
        );
      if (path === "/api/v1/projects/proj-1/environments" && method === "GET")
        return new Response(JSON.stringify([{ name: "prod" }]), {
          status: 200,
        });
      return new Response(
        JSON.stringify({
          message:
            "Server has multiple destinations and you do not set destination_uuid.",
        }),
        { status: 400 },
      );
    }) as unknown as typeof fetch;
  }

  const exec = (fetchImpl: typeof fetch) =>
    buildExecutor(new CoolifyClient("https://coolify.test", "tok", fetchImpl), {
      projectName: "widget",
      envName: "prod",
      serverUuid: "srv-1",
      githubAppUuid: "gh-1",
      // The names the message has to be able to say back. None is on the wire:
      // Coolify knows srv-1, the operator wrote prod-box.
      serverName: "prod-box",
      orgRepo: "heavy-duty/incubator",
      bindingEnv: "prod",
    });

  const kinds = [
    { label: "application", change: app },
    {
      label: "database",
      change: {
        kind: "database" as const,
        name: "postgres",
        op: "create" as const,
        fieldDiffs: [
          { field: "type", desired: "postgresql", updatable: false },
        ],
        envDiffs: [],
      },
    },
    {
      label: "service",
      change: {
        kind: "service" as const,
        name: "umami",
        op: "create" as const,
        fieldDiffs: [{ field: "type", desired: "umami", updatable: false }],
        envDiffs: [],
      },
    },
  ];

  // Every kind, because which one 400s first depends only on the order of the
  // manifest — Coolify runs the same destination logic in all three controllers.
  it.each(kinds)(
    "answers the $label 400 with the state-file path the UUID goes in",
    async ({ change }) => {
      const err = await exec(multiDestinationCoolify())
        .createResource(change)
        .catch((e: Error) => e);

      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      // The remedy: the exact key, in the exact place, with the repo and the env
      // the operator actually named.
      expect(message).toContain(
        "environments.prod.projects.heavy-duty/incubator.destination_uuid",
      );
      // The server, by the name the operator wrote — not srv-1.
      expect(message).toContain("prod-box has multiple destinations");
      // Which resource it died on, so a half-applied run can be read.
      expect(message).toContain(`cannot create ${change.kind} ${change.name}`);
      // Create-time: the part that decides whether they can fix this with an
      // apply (they cannot) or a delete + recreate (they must).
      expect(message).toMatch(/cannot be moved between networks later/);
      // Coolify's own words survive — a translation that hides the original
      // makes the next person's search fail.
      expect(message).toContain(
        "Server has multiple destinations and you do not set destination_uuid.",
      );
    },
  );

  // The translation must be about THIS 400, not about 400s. A create rejected for
  // any other reason has to arrive unmolested, or the next bug gets a confident
  // answer about a destination it has nothing to do with.
  it("leaves every other failure exactly as Coolify sent it", async () => {
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (path === "/api/v1/projects" && method === "GET")
        return new Response(
          JSON.stringify([{ uuid: "proj-1", name: "widget" }]),
          { status: 200 },
        );
      if (path === "/api/v1/projects/proj-1/environments" && method === "GET")
        return new Response(JSON.stringify([{ name: "prod" }]), {
          status: 200,
        });
      return new Response(
        JSON.stringify({ message: "The name field is required." }),
        { status: 422 },
      );
    }) as unknown as typeof fetch;

    const err = await exec(fetchImpl)
      .createResource(app)
      .catch((e: Error) => e);

    expect((err as Error).message).toContain("The name field is required.");
    expect((err as Error).message).not.toMatch(/destination/);
  });
});

describe("databaseVersionFromImage / defaultDatabaseImage", () => {
  it("round-trips through defaultDatabaseImage for postgres", () => {
    const image = defaultDatabaseImage("postgresql", "17");
    expect(databaseVersionFromImage(image)).toBe("17");
  });
});

// The write half of #51. Backup schedules live on their own route
// (/databases/{uuid}/backups), so `apply` has to read that route to know
// whether to POST or PATCH — and used to do neither outside the create branch.
describe("buildExecutor backup schedules", () => {
  type Call = { method: string; path: string; body?: unknown };

  // Records every request so a test can assert not just what was written, but
  // what was NOT — a schedule silently skipped is the whole defect.
  function recorder(handler: (path: string, init?: RequestInit) => Response): {
    calls: Call[];
    fetchImpl: typeof fetch;
  } {
    const calls: Call[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({
        method: init?.method ?? "GET",
        path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return handler(path, init);
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const ctx = {
    projectName: "widget",
    envName: "prod",
    serverUuid: "srv-1",
    githubAppUuid: "gh-1",
    serverName: "prod-box",
    orgRepo: "acme/widget",
    bindingEnv: "prod",
    s3DestinationUuid: "s3-1",
  };

  const schedule = { frequency: "0 3 * * *", retention: 7 };
  const liveRow = {
    uuid: "sched-1",
    frequency: "0 5 * * *",
    database_backup_retention_amount_locally: 3,
    enabled: true,
  };

  // THE FIX. A database that exists and has no schedule gets one on update —
  // before this, `apply` wrote a schedule only inside the create branch, so
  // adding `backup:` to a live database was a clean run and zero backups.
  it("CREATES the schedule on update when the database has none", async () => {
    const { calls, fetchImpl } = recorder((path, init) => {
      if (path === "/api/v1/databases/db-1/backups" && init?.method === "POST")
        return new Response(JSON.stringify({ uuid: "sched-new" }), {
          status: 201,
        });
      if (path === "/api/v1/databases/db-1/backups")
        return new Response(JSON.stringify([]), { status: 200 }); // read: none
      return new Response("{}", { status: 200 });
    });
    const exec = buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      ctx,
    );
    await exec.updateFields("db-1", "database", { backup: schedule });
    const post = calls.find((c) => c.method === "POST");
    expect(post?.path).toBe("/api/v1/databases/db-1/backups");
    expect(post?.body).toEqual({
      frequency: "0 3 * * *",
      database_backup_retention_amount_locally: 7,
      save_s3: true,
      s3_storage_uuid: "s3-1",
      enabled: true,
    });
  });

  it("PATCHES the existing schedule rather than adding a second one", async () => {
    const { calls, fetchImpl } = recorder((path, init) => {
      if (path === "/api/v1/databases/db-1/backups" && init?.method === "GET")
        return new Response(JSON.stringify([liveRow]), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const exec = buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      ctx,
    );
    await exec.updateFields("db-1", "database", { backup: schedule });
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe("/api/v1/databases/db-1/backups/sched-1");
    expect(patch?.body).toMatchObject({
      frequency: "0 3 * * *",
      database_backup_retention_amount_locally: 7,
      // Re-enabled: declaring `backup:` asks for backups, not for a disabled
      // row that looks like backups.
      enabled: true,
    });
  });

  it("does not PATCH the database itself for a backup-only change", async () => {
    const { calls, fetchImpl } = recorder((path, init) => {
      if (path === "/api/v1/databases/db-1/backups" && init?.method === "GET")
        return new Response(JSON.stringify([liveRow]), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    const exec = buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      ctx,
    );
    await exec.updateFields("db-1", "database", { backup: schedule });
    // `backup` is not a column on the database — it must never reach the
    // database's own update body, and an empty body is not worth a write.
    expect(calls.some((c) => c.path === "/api/v1/databases/db-1")).toBe(false);
  });

  // Degrade honestly: an apply that promised a backup schedule and cannot tell
  // whether one already exists must STOP, not guess. POSTing blind would
  // duplicate an existing schedule; skipping is the silent no-op being fixed.
  it("refuses to guess when the schedule read fails", async () => {
    const { calls, fetchImpl } = recorder((path, init) => {
      if (path === "/api/v1/databases/db-1/backups" && init?.method === "GET")
        return new Response("gateway timeout", { status: 504 });
      return new Response("{}", { status: 200 });
    });
    const exec = buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      ctx,
    );
    await expect(
      exec.updateFields("db-1", "database", { backup: schedule }),
    ).rejects.toThrow(/cannot set the declared backup schedule/);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("refuses to guess which of several schedules the manifest meant", async () => {
    const { fetchImpl } = recorder((path, init) => {
      if (path === "/api/v1/databases/db-1/backups" && init?.method === "GET")
        return new Response(
          JSON.stringify([liveRow, { ...liveRow, uuid: "sched-2" }]),
          { status: 200 },
        );
      return new Response("{}", { status: 200 });
    });
    const exec = buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      ctx,
    );
    await expect(
      exec.updateFields("db-1", "database", { backup: schedule }),
    ).rejects.toThrow(/holds 2 backup schedules/);
  });

  it("leaves an undeclared schedule alone (apply never removes)", async () => {
    const { calls, fetchImpl } = recorder(
      () => new Response("{}", { status: 200 }),
    );
    const exec = buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      ctx,
    );
    await exec.updateFields("db-1", "database", { version: "17" });
    expect(calls.some((c) => c.path.includes("/backups"))).toBe(false);
  });

  it("still POSTs the schedule on create, without a read", async () => {
    const { calls, fetchImpl } = recorder((path) => {
      if (path === "/api/v1/projects")
        return new Response(
          JSON.stringify([{ uuid: "proj-1", name: "widget" }]),
          { status: 200 },
        );
      if (path === "/api/v1/projects/proj-1/environments")
        return new Response(JSON.stringify([{ name: "prod" }]), {
          status: 200,
        });
      if (path === "/api/v1/databases/postgresql")
        return new Response(JSON.stringify({ uuid: "db-9" }), { status: 201 });
      return new Response(JSON.stringify({ uuid: "sched-9" }), { status: 201 });
    });
    const exec = buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      ctx,
    );
    await exec.createResource({
      kind: "database",
      name: "postgres",
      op: "create",
      fieldDiffs: [
        { field: "type", desired: "postgresql", updatable: false },
        { field: "backup", desired: schedule, updatable: true },
      ],
      envDiffs: [],
    });
    // A database created a moment ago provably has no schedule: POST straight
    // out, with no read that could fail and abort the create.
    expect(
      calls.some((c) => c.method === "GET" && c.path.includes("/backups")),
    ).toBe(false);
    const post = calls.find((c) => c.path === "/api/v1/databases/db-9/backups");
    expect(post?.body).toMatchObject({ frequency: "0 3 * * *", save_s3: true });
    // And `backup` never reaches the database's own create body.
    const create = calls.find((c) => c.path === "/api/v1/databases/postgresql");
    expect(create?.body).not.toHaveProperty("backup");
  });

  it("refuses a declared schedule with no s3_destination configured", async () => {
    const { fetchImpl } = recorder(
      () => new Response(JSON.stringify([]), { status: 200 }),
    );
    const exec = buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      { ...ctx, s3DestinationUuid: undefined },
    );
    await expect(
      exec.updateFields("db-1", "database", { backup: schedule }),
    ).rejects.toThrow(/no s3_destination UUID/);
  });
});

// The from-nothing half of derived resource URLs (#60): at plan time the
// database did not exist, so the app's ${resource:postgres.url} is still
// unresolved when apply goes to write its env. syncEnv reads the URL back from
// the environment_details route (the database was created earlier in the same
// apply) and writes the real value — or refuses, rather than writing a blank.
describe("buildExecutor syncEnv (derived resource URLs, #60)", () => {
  const ctx = {
    projectName: "widget",
    envName: "prod",
    serverUuid: "srv-1",
    githubAppUuid: "gh-1",
    serverName: "prod-box",
    orgRepo: "acme/widget",
    bindingEnv: "prod",
  };
  const derivedEnv = {
    vars: {
      DATABASE_URL: {
        value: DERIVED_UNRESOLVED,
        secret: true,
        derived: { resource: "postgres", attr: "url" as const },
      },
    },
  };
  const URL_ = "postgres://u:p@pg-uuid:5432/widget";

  // Serves /projects and the environment_details route; records the envs/bulk
  // write so a test can assert what value landed (or that none did).
  function box(internalDbUrl?: string) {
    const bulkBodies: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/projects")
        return new Response(
          JSON.stringify([{ uuid: "proj-1", name: "widget" }]),
          { status: 200 },
        );
      if (path === "/api/v1/projects/proj-1/prod")
        return new Response(
          JSON.stringify({
            postgresqls: [
              internalDbUrl === undefined
                ? { name: "postgres" }
                : { name: "postgres", internal_db_url: internalDbUrl },
            ],
          }),
          { status: 200 },
        );
      if (path === "/api/v1/applications/app-1/envs/bulk") {
        bulkBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, bulkBodies };
  }

  it("resolves the ref from the live database and writes the real URL", async () => {
    const { fetchImpl, bulkBodies } = box(URL_);
    const exec = buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      ctx,
    );
    await exec.syncEnv("app-1", "application", derivedEnv);
    expect(bulkBodies).toHaveLength(1);
    expect(bulkBodies[0]).toEqual({
      data: [
        {
          key: "DATABASE_URL",
          value: URL_,
          is_buildtime: false,
          is_preview: false,
        },
      ],
    });
  });

  it("refuses — and writes nothing — when the database has no URL yet", async () => {
    const { fetchImpl, bulkBodies } = box(undefined);
    const exec = buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      ctx,
    );
    await expect(
      exec.syncEnv("app-1", "application", derivedEnv),
    ).rejects.toThrow(/cannot resolve derived env var/);
    expect(bulkBodies).toHaveLength(0);
  });

  it("does not read the box at all when there is nothing derived to resolve", async () => {
    const { fetchImpl, bulkBodies } = box(URL_);
    const exec = buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      ctx,
    );
    await exec.syncEnv("app-1", "application", {
      vars: { PORT: { value: "3000", secret: false } },
    });
    // Straight to the write — no /projects lookup for a derived URL.
    expect(bulkBodies).toHaveLength(1);
    expect(
      (
        fetchImpl as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls.some(([u]) => String(u).endsWith("/projects")),
    ).toBe(false);
  });
});
