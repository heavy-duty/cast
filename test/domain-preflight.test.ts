import { describe, expect, it, vi } from "vitest";
import {
  buildExecutor,
  desiredDomainsOfCreate,
  domainConflictRemedy,
  findDomainConflicts,
  liveApplicationDomains,
  preflightDomainConflicts,
} from "../src/cli.js";
import { CoolifyClient } from "../src/coolify.js";
import type { Change } from "../src/diff.js";

// #44: Coolify enforces domain uniqueness across the WHOLE instance
// (bootstrap/helpers/domains.php@checkIfDomainIsAlreadyUsedViaAPI, v4.1.2); cast
// plans inside one project + one environment. So a plan can be correct against
// everything cast can observe and still be refused — by a resource cast cannot see,
// with a raw 409, mid-apply, after the project and the environment have been made.
//
// Three things are under test here, and none of them is the happy path: the plan
// that gets REFUSED before it writes, the 409 that gets TRANSLATED when one still
// arrives, and the flag cast must never send to make either of them go away.

const create = (name: string, fields: Record<string, unknown>): Change => ({
  kind: "application",
  name,
  op: "create",
  fieldDiffs: Object.entries(fields).map(([field, desired]) => ({
    field,
    desired,
    updatable: true,
  })),
  envDiffs: [],
});

// A live non-compose application, as GET /applications actually serializes one:
// `fqdn` is a comma-separated string. (The vendored OpenAPI does not document the
// field at all — it is there because ApplicationsController@applications runs the
// same removeSensitiveData() as the per-app GET, and hides neither.)
const liveApp = (name: string, uuid: string, fqdn: string | null) => ({
  uuid,
  name,
  build_pack: "nixpacks",
  fqdn,
});

// A live dockercompose application: domains live per-service, JSON-encoded.
const liveComposeApp = (
  name: string,
  uuid: string,
  services: Record<string, string>,
) => ({
  uuid,
  name,
  build_pack: "dockercompose",
  fqdn: null,
  docker_compose_domains: JSON.stringify(
    Object.entries(services).map(([n, domain]) => ({ name: n, domain })),
  ),
});

describe("reading the domains of a plan and of an instance", () => {
  it("takes an application create's flat domains and its per-service ones", () => {
    expect(
      desiredDomainsOfCreate(
        create("core", { domains: ["https://a.example.com"] }),
      ),
    ).toEqual([{ domain: "https://a.example.com" }]);
    expect(
      desiredDomainsOfCreate(
        create("core", {
          build_pack: "dockercompose",
          docker_compose_domains: {
            api: ["https://api.example.com", "https://alt.example.com"],
            web: ["https://web.example.com"],
          },
        }),
      ),
    ).toEqual([
      { domain: "https://api.example.com", service: "api" },
      { domain: "https://alt.example.com", service: "api" },
      { domain: "https://web.example.com", service: "web" },
    ]);
  });

  // Databases have none, and cast's service creates drop `domains` on the wire
  // (serviceApiFields) — an application create is the only way an apply claims one.
  it("claims nothing for a database or service create, or for an update", () => {
    const db: Change = {
      kind: "database",
      name: "postgres",
      op: "create",
      fieldDiffs: [{ field: "type", desired: "postgresql", updatable: false }],
      envDiffs: [],
    };
    const update: Change = {
      ...create("core", { domains: ["https://a.example.com"] }),
      op: "update",
      uuid: "live-1",
    };
    expect(desiredDomainsOfCreate(db)).toEqual([]);
    expect(desiredDomainsOfCreate(update)).toEqual([]);
  });

  it("reads both live shapes: fqdn, and per-service compose domains", () => {
    expect(
      liveApplicationDomains(
        liveApp("core", "u1", "https://a.example.com,https://b.example.com"),
      ),
    ).toEqual([
      { domain: "https://a.example.com" },
      { domain: "https://b.example.com" },
    ]);
    expect(
      liveApplicationDomains(
        liveComposeApp("core", "u1", { api: "https://api.example.com" }),
      ),
    ).toEqual([{ domain: "https://api.example.com", service: "api" }]);
  });
});

describe("finding what Coolify would refuse", () => {
  it("catches a plain fqdn conflict and names the resource holding it", () => {
    const conflicts = findDomainConflicts(
      [create("core", { domains: ["https://api.example.com"] })],
      [
        liveApp("unrelated", "u1", "https://other.example.com"),
        liveApp("core", "tqsmnzdde6oxz3fhl63e2xvl", "https://api.example.com"),
      ],
    );
    expect(conflicts).toEqual([
      {
        domain: "https://api.example.com",
        resource_name: "core",
        resource_uuid: "tqsmnzdde6oxz3fhl63e2xvl",
        resource_type: "application",
        wanted_by: "application core",
      },
    ]);
  });

  // The shape the real incident had: both sides dockercompose, the domain held by a
  // SERVICE of an app in a project cast never queries.
  it("catches a per-service compose conflict, on both sides", () => {
    const conflicts = findDomainConflicts(
      [
        create("core", {
          build_pack: "dockercompose",
          docker_compose_domains: {
            api: ["http://api.89.167.19.110.sslip.io"],
          },
        }),
      ],
      [
        liveComposeApp("core", "tqsmnzdde6oxz3fhl63e2xvl", {
          api: "http://api.89.167.19.110.sslip.io",
          web: "http://89.167.19.110.sslip.io",
        }),
      ],
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      domain: "http://api.89.167.19.110.sslip.io",
      resource_uuid: "tqsmnzdde6oxz3fhl63e2xvl",
      service_name: "api",
      wanted_by: "application core (service: api)",
    });
  });

  it("strips one trailing slash on both sides, exactly as Coolify does", () => {
    expect(
      findDomainConflicts(
        [create("core", { domains: ["https://api.example.com/"] })],
        [liveApp("ghost", "u1", "https://api.example.com")],
      ),
    ).toHaveLength(1);
    expect(
      findDomainConflicts(
        [create("core", { domains: ["https://api.example.com"] })],
        [liveApp("ghost", "u1", "https://api.example.com/")],
      ),
    ).toHaveLength(1);
  });

  // Coolify compares the strings LITERALLY, scheme included (domains.php ~L153-177).
  // A pre-flight cleverer than the server it predicts is a pre-flight that disagrees
  // with it — here, by refusing an apply Coolify would have allowed.
  it("does not treat http:// and https:// as the same domain", () => {
    expect(
      findDomainConflicts(
        [create("core", { domains: ["https://api.example.com"] })],
        [liveApp("ghost", "u1", "http://api.example.com")],
      ),
    ).toEqual([]);
  });

  // domains.php L189 gates the compose check on build_pack === 'dockercompose'.
  // A nixpacks app carrying stale compose-domain JSON does NOT conflict for Coolify,
  // so it must not conflict for cast either — a false refusal blocks a correct apply.
  it("ignores compose domains on an app whose build_pack is not dockercompose", () => {
    expect(
      findDomainConflicts(
        [create("core", { domains: ["https://api.example.com"] })],
        [
          {
            ...liveApp("stale", "u1", null),
            docker_compose_domains: JSON.stringify([
              { name: "api", domain: "https://api.example.com" },
            ]),
          },
        ],
      ),
    ).toEqual([]);
  });

  it("is silent when nothing is claimed", () => {
    expect(
      findDomainConflicts(
        [create("core", { domains: ["https://api.example.com"] })],
        [liveApp("other", "u1", "https://elsewhere.example.com")],
      ),
    ).toEqual([]);
  });
});

describe("preflightDomainConflicts", () => {
  const instance = (apps: unknown[]) => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/v1/applications")
        return new Response(JSON.stringify(apps), { status: 200 });
      throw new Error(`unexpected request: ${path}`);
    }) as unknown as typeof fetch;
    return {
      client: new CoolifyClient("https://coolify.test", "tok", fetchImpl),
      fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
    };
  };

  it("reads the whole instance once and reports the conflict", async () => {
    const { client, fetchImpl } = instance([
      liveApp("core", "tqsmnzdde6oxz3fhl63e2xvl", "https://api.example.com"),
    ]);
    const conflicts = await preflightDomainConflicts(client, [
      create("core", { domains: ["https://api.example.com"] }),
    ]);
    expect(conflicts).toHaveLength(1);
    // One call. GET /applications carries fqdn and docker_compose_domains already
    // (same serializer as the per-app GET), so the N+1 the issue expected is not
    // needed — and a per-app GET would return byte-for-byte the same fields.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // The cost has to be nothing on the runs that are not first applies — which is
  // every run but one, forever.
  it("touches Coolify at all only when the plan creates an application with a domain", async () => {
    const { client, fetchImpl } = instance([]);
    const update: Change = {
      ...create("core", { domains: ["https://api.example.com"] }),
      op: "update",
      uuid: "live-1",
    };
    expect(await preflightDomainConflicts(client, [update])).toEqual([]);
    expect(
      await preflightDomainConflicts(client, [
        create("core", { build_pack: "nixpacks" }),
      ]),
    ).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the refusal an operator actually reads", () => {
  const conflict = {
    domain: "http://api.89.167.19.110.sslip.io",
    resource_name: "core",
    resource_uuid: "tqsmnzdde6oxz3fhl63e2xvl",
    resource_type: "application",
    service_name: "api",
    wanted_by: "application core (service: api)",
  };

  it("names the resource, its uuid, and that it is OUTSIDE the applied project", () => {
    const message = domainConflictRemedy([conflict], {
      project: "incubator",
      env: "production",
      visible: new Set(["some-app-in-this-project"]),
      stage: "preflight",
    });
    expect(message).toContain("http://api.89.167.19.110.sslip.io");
    expect(message).toContain("application 'core' (service: api)");
    expect(message).toContain("uuid tqsmnzdde6oxz3fhl63e2xvl");
    // The part the operator cannot work out from Coolify's own message.
    expect(message).toContain("NOT in incubator / production");
    expect(message).toContain("cast can neither see nor manage it");
    // And where it came from, which is the part that stops it happening again.
    expect(message).toMatch(
      /deleting a project does NOT delete its resources/i,
    );
    // Refused before the first write.
    expect(message).toContain("Nothing was created");
  });

  // The scope claim is the whole message, so it is checked rather than assumed: a
  // conflict with something in the plan's OWN project is a different fix, and "cast
  // cannot see it" would be a lie about a resource sitting in the diff.
  it("says the opposite when the conflicting resource IS in this project", () => {
    const message = domainConflictRemedy([conflict], {
      project: "incubator",
      env: "production",
      visible: new Set(["tqsmnzdde6oxz3fhl63e2xvl"]),
      stage: "preflight",
    });
    expect(message).toContain("It IS in incubator / production");
    expect(message).not.toContain("cast can neither see nor manage it");
  });

  it("refuses force_domain_override in the same breath as naming it", () => {
    const message = domainConflictRemedy([conflict], {
      project: "incubator",
      env: "production",
      visible: new Set(),
      stage: "preflight",
    });
    expect(message).toContain(
      "cast will NOT retry with force_domain_override=true",
    );
    expect(message).toContain("routing conflicts and unpredictable behavior");
  });
});

// The 409 that gets through anyway: Coolify also checks service fqdns and the
// instance fqdn, neither of which GET /applications lists. The pre-flight is a
// subset of Coolify's check, so the translation is not dead code.
describe("buildExecutor createResource (domain-conflict 409, #44)", () => {
  const app = create("core", {
    build_pack: "dockercompose",
    docker_compose_domains: { api: ["http://api.89.167.19.110.sslip.io"] },
  });

  // Coolify's real answer, verbatim (ApplicationsController L1112-1127 @ v4.1.2).
  const conflict409 = JSON.stringify({
    message:
      "Domain conflicts detected. Use force_domain_override=true to proceed.",
    conflicts: [
      {
        domain: "http://api.89.167.19.110.sslip.io",
        resource_name: "core",
        resource_uuid: "tqsmnzdde6oxz3fhl63e2xvl",
        resource_type: "application",
        service_name: "api",
        message:
          "Domain http://api.89.167.19.110.sslip.io is already in use by application 'core' (service: api)",
      },
    ],
    warning:
      "Using the same domain for multiple resources can cause routing conflicts and unpredictable behavior.",
  });

  const coolify = (createResponse: Response | (() => Response)) => {
    const bodies: unknown[] = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const method = init?.method ?? "GET";
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      if (path === "/api/v1/projects" && method === "GET")
        return new Response(
          JSON.stringify([{ uuid: "proj-1", name: "incubator" }]),
          { status: 200 },
        );
      if (path === "/api/v1/projects/proj-1/environments" && method === "GET")
        return new Response(JSON.stringify([{ name: "production" }]), {
          status: 200,
        });
      return typeof createResponse === "function"
        ? createResponse()
        : createResponse.clone();
    }) as unknown as typeof fetch;
    return { fetchImpl, bodies };
  };

  const exec = (fetchImpl: typeof fetch) =>
    buildExecutor(new CoolifyClient("https://coolify.test", "tok", fetchImpl), {
      projectName: "incubator",
      envName: "production",
      serverUuid: "srv-1",
      githubAppUuid: "gh-1",
      serverName: "prod-box",
      orgRepo: "heavy-duty/incubator",
      bindingEnv: "production",
      backupSchedules: {},
      visibleUuids: new Set(["an-app-cast-can-see"]),
    });

  it("translates it into the scope fact Coolify never states", async () => {
    const { fetchImpl, bodies } = coolify(
      new Response(conflict409, { status: 409 }),
    );
    const err = await exec(fetchImpl)
      .createResource(app)
      .catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("Coolify refused");
    expect(message).toContain("uuid tqsmnzdde6oxz3fhl63e2xvl");
    expect(message).toContain("NOT in incubator / production");
    expect(message).toMatch(
      /deleting a project does NOT delete its resources/i,
    );
    // Mid-apply: the project and the environment are already there. The operator
    // needs to know the re-run is safe, which is a different sentence from the
    // pre-flight's "nothing was created".
    expect(message).toContain("arrived mid-apply");
    // Coolify's own words survive the translation.
    expect(message).toContain("Domain conflicts detected");
    // The suggestion in those words is answered, not followed.
    expect(message).toContain(
      "cast will NOT retry with force_domain_override=true",
    );
    // And nothing was retried: one create attempt, and not one request body in the
    // whole exchange carried the flag.
    expect(bodies).toHaveLength(1);
    for (const body of bodies)
      expect(body).not.toHaveProperty("force_domain_override");
  });

  // 409 is also how Coolify answers a duplicate environment create (ensureEnvironment
  // swallows exactly that). Narrowing on the status alone would make this translation
  // claim any of them.
  it("leaves a 409 that carries no conflicts exactly as Coolify sent it", async () => {
    const { fetchImpl } = coolify(
      new Response(JSON.stringify({ message: "Already exists." }), {
        status: 409,
      }),
    );
    const err = await exec(fetchImpl)
      .createResource(app)
      .catch((e: Error) => e);

    expect((err as Error).message).toContain(
      '409: {"message":"Already exists."}',
    );
    expect((err as Error).message).not.toContain("force_domain_override");
  });
});
