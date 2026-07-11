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

describe("databaseVersionFromImage / defaultDatabaseImage", () => {
  it("round-trips through defaultDatabaseImage for postgres", () => {
    const image = defaultDatabaseImage("postgresql", "17");
    expect(databaseVersionFromImage(image)).toBe("17");
  });
});
