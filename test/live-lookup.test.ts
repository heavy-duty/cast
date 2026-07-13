import { describe, expect, it, vi } from "vitest";
import { fetchLive, renderAbsentTarget } from "../src/cli.js";
import { CoolifyClient } from "../src/coolify.js";

// A Coolify that answers GET /projects with `projects`, and
// GET /projects/{uuid}/{env} with whatever `envByProject` holds for it
// (undefined → 404, which is how Coolify says "no such environment").
function coolify(
  projects: Array<{ uuid: string; name: string }>,
  envByProject: Record<string, unknown> = {},
): CoolifyClient {
  const fetchImpl = vi.fn(async (url: string | URL) => {
    const path = new URL(String(url)).pathname.replace("/api/v1", "");
    if (path === "/projects") {
      return new Response(JSON.stringify(projects), { status: 200 });
    }
    const m = path.match(/^\/projects\/([^/]+)\/(.+)$/);
    if (m) {
      const body = envByProject[`${m[1]}/${m[2]}`];
      return body === undefined
        ? new Response(JSON.stringify({ message: "Not found." }), {
            status: 404,
          })
        : new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("{}", { status: 500 });
  }) as unknown as typeof fetch;
  return new CoolifyClient("https://coolify.test", "tok", fetchImpl);
}

describe("fetchLive", () => {
  it("returns the live resources when project and environment both exist", async () => {
    const client = coolify([{ uuid: "p1", name: "incubator" }], {
      "p1/prod": {
        applications: [{ name: "core", uuid: "a1" }],
        postgresqls: [{ name: "db", uuid: "d1" }],
      },
    });
    const r = await fetchLive(client, "incubator", "prod");
    expect(r.found).toBe(true);
    if (!r.found) throw new Error("unreachable");
    expect(r.live.map((l) => l.name).sort()).toEqual(["core", "db"]);
  });

  // The bug this whole change exists for: an absent project used to come back
  // as [], which computeDiff reads as "every desired resource is missing" and
  // renders as a confident full-create plan. Absence must be its own answer,
  // distinguishable from an empty-but-real environment.
  it("reports an ABSENT project as absent, not as empty", async () => {
    const client = coolify([
      { uuid: "p1", name: "incubator-prod" },
      { uuid: "p2", name: "umami" },
    ]);
    const r = await fetchLive(client, "incubator", "prod");
    expect(r).toEqual({
      found: false,
      missing: "project",
      project: "incubator",
      available: ["incubator-prod", "umami"],
    });
  });

  // Same lie, a different road: the project is real but the environment name
  // is not. A hand-built project is very often `production`, not `prod`.
  it("reports an ABSENT environment as absent, not as empty", async () => {
    const client = coolify([{ uuid: "p1", name: "incubator" }], {
      "p1/production": { applications: [] },
    });
    const r = await fetchLive(client, "incubator", "prod");
    expect(r).toEqual({
      found: false,
      missing: "environment",
      project: "incubator",
      environment: "prod",
    });
  });

  // The distinction has to be real in BOTH directions, or the gate would just
  // trade a false pass for a false alarm: a project whose environment exists
  // and is genuinely empty is `found`, with zero resources.
  it("distinguishes a real-but-empty environment from an absent one", async () => {
    const client = coolify([{ uuid: "p1", name: "incubator" }], {
      "p1/prod": { applications: [], postgresqls: [], services: [] },
    });
    const r = await fetchLive(client, "incubator", "prod");
    expect(r).toEqual({ found: true, live: [] });
  });
});

describe("renderAbsentTarget", () => {
  it("names what it looked for, where the name came from, and what exists", () => {
    const msg = renderAbsentTarget(
      {
        found: false,
        missing: "project",
        project: "incubator",
        available: ["incubator-prod", "umami"],
      },
      { orgRepo: "heavy-duty/incubator", overridden: false },
    );
    expect(msg).toMatch(/no project named "incubator"/);
    expect(msg).toMatch(/derived from the repo slug heavy-duty\/incubator/);
    expect(msg).toMatch(/incubator-prod, umami/);
    expect(msg).toMatch(/--project <name>/);
    // The reader must not be able to walk away thinking a clean diff was a pass.
    expect(msg).toMatch(/verified\s+nothing/);
  });

  it("says the name came from --project when it was overridden", () => {
    const msg = renderAbsentTarget(
      {
        found: false,
        missing: "project",
        project: "typo",
        available: ["incubator"],
      },
      { orgRepo: "heavy-duty/incubator", overridden: true },
    );
    expect(msg).toMatch(/\(--project\)/);
  });

  it("points at the UI-naming gotcha when the environment is what is missing", () => {
    const msg = renderAbsentTarget(
      {
        found: false,
        missing: "environment",
        project: "incubator",
        environment: "prod",
      },
      { orgRepo: "heavy-duty/incubator", overridden: false },
    );
    expect(msg).toMatch(/has no environment "prod"/);
    expect(msg).toMatch(/production/);
    expect(msg).toMatch(/--env/);
  });
});
