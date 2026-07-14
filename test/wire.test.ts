import { describe, expect, it, vi } from "vitest";
import {
  applicationApiFields,
  buildExecutor,
  databaseApiFields,
  databaseVersionFromImage,
  defaultDatabaseImage,
  projectLiveFields,
  serviceApiFields,
} from "../src/cli.js";
import { CoolifyClient } from "../src/coolify.js";
import { computeDiff } from "../src/diff.js";

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
  it("drops domains (services have no flat-domains create/update field)", () => {
    const out = serviceApiFields({
      type: "plausible",
      domains: ["https://stats.example.com"],
    });
    expect(out).toEqual({ type: "plausible" });
    expect(out).not.toHaveProperty("domains");
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
      backupSchedules: {},
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
      backupSchedules: {},
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
        destinationUuid: "dest-abc",
        backupSchedules: {},
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
        backupSchedules: {},
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
  }) {
    const projects = opts.projects ?? [];
    let environments = opts.environments ?? [];
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

  function exec(fetchImpl: typeof fetch) {
    return buildExecutor(
      new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      {
        projectName: "widget",
        envName: "prod",
        serverUuid: "srv-1",
        githubAppUuid: "gh-1",
        backupSchedules: {},
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
});

describe("databaseVersionFromImage / defaultDatabaseImage", () => {
  it("round-trips through defaultDatabaseImage for postgres", () => {
    const image = defaultDatabaseImage("postgresql", "17");
    expect(databaseVersionFromImage(image)).toBe("17");
  });
});
