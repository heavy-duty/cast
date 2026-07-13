import { describe, expect, it } from "vitest";
import {
  type Bindings,
  type ProjectBinding,
  githubAppNameFor,
  loadBindings,
  projectBindingFor,
  projectsIn,
  smokeTargetFor,
} from "../src/bindings.js";

function bindings(github_apps: Record<string, string>): Bindings {
  return {
    environments: {
      prod: { server: "prod-box", team: { id: 0, name: "Root Team" } },
    },
    github_apps,
  } as Bindings;
}

function withProjects(
  projects: Record<string, ProjectBinding>,
  smoke_target?: string,
): Bindings {
  return {
    environments: {
      prod: {
        server: "shared-box",
        team: { id: 0, name: "Root Team" },
        projects,
      },
      staging: { server: "staging-box", team: { id: 0, name: "Root Team" } },
    },
    github_apps: {},
    ...(smoke_target ? { smoke_target } : {}),
  } as Bindings;
}

describe("githubAppNameFor", () => {
  it("resolves the full <org>/<repo> slug", () => {
    const b = bindings({ "heavy-duty/incubator": "hdb-coolify" });
    expect(githubAppNameFor(b, "heavy-duty/incubator")).toBe("hdb-coolify");
  });

  // Every state file written before full-slug keying uses the bare repo name.
  // Dropping that would break them for no gain, so it stays as a fallback.
  it("still resolves a legacy bare <repo> key", () => {
    const b = bindings({ incubator: "hdb-coolify" });
    expect(githubAppNameFor(b, "heavy-duty/incubator")).toBe("hdb-coolify");
  });

  // The whole point of the issue. A short name is unique only *within* an org,
  // so two orgs' same-named repos collapse onto one key — and the loser gets
  // cloned by the winner's App, silently, because a wrong-but-existing App
  // still resolves to a real uuid and the create succeeds.
  it("keeps two orgs' same-named repos on separate Apps", () => {
    const b = bindings({
      "heavy-duty/incubator": "hdb-coolify",
      "acme/incubator": "acme-coolify",
    });
    expect(githubAppNameFor(b, "heavy-duty/incubator")).toBe("hdb-coolify");
    expect(githubAppNameFor(b, "acme/incubator")).toBe("acme-coolify");
  });

  // Precedence matters in exactly the case that motivated the fix: a state file
  // mid-migration carries both a legacy short key and a new full-slug one. The
  // slug is the thing that actually identifies a repo, so it must win.
  it("prefers the full slug over a colliding bare key", () => {
    const b = bindings({
      incubator: "legacy-app",
      "heavy-duty/incubator": "hdb-coolify",
    });
    expect(githubAppNameFor(b, "heavy-duty/incubator")).toBe("hdb-coolify");
  });

  it("refuses an unbound repo, naming both keys it tried", () => {
    const b = bindings({ "heavy-duty/other": "other-app" });
    const err = githubAppNameFor.bind(
      null,
      b,
      "heavy-duty/incubator",
    ) as () => string;
    expect(err).toThrow(/no GitHub App bound for heavy-duty\/incubator/);
    expect(err).toThrow(/github_apps\["heavy-duty\/incubator"\]/);
    expect(err).toThrow(/github_apps\["incubator"\]/);
    expect(err).toThrow(/heavy-duty\/other/);
  });
});

describe("projectBindingFor", () => {
  it("resolves the full slug, and a legacy bare <repo> key", () => {
    const bySlug = withProjects({
      "heavy-duty/incubator": { destination_uuid: "dest-a" },
    });
    const byShort = withProjects({ incubator: { destination_uuid: "dest-a" } });
    expect(
      projectBindingFor(bySlug, "prod", "heavy-duty/incubator")
        ?.destination_uuid,
    ).toBe("dest-a");
    expect(
      projectBindingFor(byShort, "prod", "heavy-duty/incubator")
        ?.destination_uuid,
    ).toBe("dest-a");
  });

  // The reason the destination has to be project-scoped at all: one server, two
  // projects, two networks. An environment-scoped key could not say this.
  it("gives two projects on one server two different destinations", () => {
    const b = withProjects({
      "heavy-duty/incubator": { destination_uuid: "dest-incubator" },
      "acme/client-site": { destination_uuid: "dest-client" },
    });
    expect(
      projectBindingFor(b, "prod", "heavy-duty/incubator")?.destination_uuid,
    ).toBe("dest-incubator");
    expect(
      projectBindingFor(b, "prod", "acme/client-site")?.destination_uuid,
    ).toBe("dest-client");
  });

  it("prefers the full slug over a colliding bare key", () => {
    const b = withProjects({
      incubator: { destination_uuid: "legacy" },
      "heavy-duty/incubator": { destination_uuid: "dest-a" },
    });
    expect(
      projectBindingFor(b, "prod", "heavy-duty/incubator")?.destination_uuid,
    ).toBe("dest-a");
  });

  // Absence is not an error: an environment whose server hosts one project has
  // nothing to declare, and that is the state of every box today.
  it("is undefined for an environment with no projects block", () => {
    const b = withProjects({ "heavy-duty/incubator": {} });
    expect(projectBindingFor(b, "staging", "heavy-duty/incubator")).toBe(
      undefined,
    );
    expect(projectBindingFor(b, "prod", "heavy-duty/other")).toBe(undefined);
  });
});

describe("smokeTargetFor", () => {
  it("prefers the project-scoped target", () => {
    const b = withProjects(
      { "heavy-duty/incubator": { smoke_target: "core" } },
      "old-target",
    );
    expect(smokeTargetFor(b, "prod", "heavy-duty/incubator")).toEqual({
      target: "core",
      source: "project",
    });
  });

  // The state file mid-migration still has only the old key — it must keep
  // smoking, exactly as the bare-`<repo>` github_apps key keeps resolving.
  it("falls back to the deprecated state-file-scoped key, and says so", () => {
    const b = withProjects({}, "old-target");
    expect(smokeTargetFor(b, "prod", "heavy-duty/incubator")).toEqual({
      target: "old-target",
      source: "deprecated",
    });
    // ...and with no repo passed at all, which is the old invocation.
    expect(smokeTargetFor(b, "prod")).toEqual({
      target: "old-target",
      source: "deprecated",
    });
  });

  it("is undefined when neither key names a target", () => {
    expect(
      smokeTargetFor(withProjects({}), "prod", "heavy-duty/incubator"),
    ).toBe(undefined);
  });

  // Two projects, each with its own smoke target: the case the old key could
  // not express at all, since it named one app for the whole state file.
  it("keeps two projects' smoke targets apart", () => {
    const b = withProjects({
      "heavy-duty/incubator": { smoke_target: "core" },
      "acme/client-site": { smoke_target: "web" },
    });
    expect(smokeTargetFor(b, "prod", "heavy-duty/incubator")?.target).toBe(
      "core",
    );
    expect(smokeTargetFor(b, "prod", "acme/client-site")?.target).toBe("web");
  });
});

describe("BindingsSchema (projects)", () => {
  it("parses a project-scoped destination and smoke_target", () => {
    const b = loadBindings("environments.yaml", {
      overrideText: `
environments:
  prod:
    server: shared-box
    team: { id: 0, name: Root Team }
    projects:
      heavy-duty/incubator:
        destination_uuid: dest-abc
        smoke_target: core
github_apps: {}
`,
    });
    expect(projectBindingFor(b, "prod", "heavy-duty/incubator")).toEqual({
      destination_uuid: "dest-abc",
      smoke_target: "core",
    });
  });

  it("rejects an unknown key under a project (a typo is not a placement)", () => {
    expect(() =>
      loadBindings("environments.yaml", {
        overrideText: `
environments:
  prod:
    server: shared-box
    team: { id: 0, name: Root Team }
    projects:
      heavy-duty/incubator:
        destination: dest-abc
github_apps: {}
`,
      }),
    ).toThrow(/invalid bindings/);
  });
});

// The registry: the list of which projects exist at all. Everything it is FOR
// (fleet iteration, rebuild-from-state) depends on it being true, and the way it
// stops being true is silent — see the refusals below.
describe("the project registry", () => {
  const twoEnvs = `
environments:
  prod:
    server: shared-box
    team: { id: 0, name: Root Team }
  staging:
    server: staging-box
    team: { id: 0, name: Root Team }
`;

  it("registers projects per environment, keyed by the full slug", () => {
    const b = loadBindings("environments.yaml", {
      overrideText: `${twoEnvs}
projects:
  heavy-duty/incubator:
    environments: [prod, staging]
  acme/client-site:
    environments: [prod]
github_apps: {}
`,
    });
    expect(b.projects).toEqual({
      "heavy-duty/incubator": { environments: ["prod", "staging"] },
      "acme/client-site": { environments: ["prod"] },
    });
  });

  describe("projectsIn", () => {
    const b = loadBindings("environments.yaml", {
      overrideText: `${twoEnvs}
projects:
  heavy-duty/incubator:
    environments: [prod, staging]
  acme/client-site:
    environments: [prod]
github_apps: {}
`,
    });

    // Sorted, not file-order: a fleet run's output is read by a human and diffed
    // by CI, and must not reshuffle because someone appended a project.
    it("gives an environment's projects, sorted", () => {
      expect(projectsIn(b, "prod")).toEqual([
        "acme/client-site",
        "heavy-duty/incubator",
      ]);
    });

    it("gives only the projects registered for that environment", () => {
      expect(projectsIn(b, "staging")).toEqual(["heavy-duty/incubator"]);
    });

    it("is empty for an environment no project is registered in", () => {
      expect(projectsIn(b, "nowhere")).toEqual([]);
    });
  });

  // The refusal the issue is actually about. A typo'd environment name makes the
  // project real and its environment imaginary: `cast diff --all` visits nothing
  // for it, reports nothing, and exits clean — and a silently skipped project
  // reads exactly like a clean one.
  it("refuses an environment that does not exist, naming the ones that do", () => {
    const err = () =>
      loadBindings("environments.yaml", {
        overrideText: `${twoEnvs}
projects:
  heavy-duty/incubator:
    environments: [prod, stagng]
github_apps: {}
`,
      });
    expect(err).toThrow(/environment "stagng", which does not exist/);
    expect(err).toThrow(/known envs:\s+prod, staging/);
  });

  // The other direction, and the one that rots quietly: per-environment state
  // (#21) sitting in an environment the registry does not register the project
  // for. The two blocks then describe two different fleets.
  it("refuses a binding in an environment the registry does not register", () => {
    const err = () =>
      loadBindings("environments.yaml", {
        overrideText: `
environments:
  prod:
    server: shared-box
    team: { id: 0, name: Root Team }
  staging:
    server: staging-box
    team: { id: 0, name: Root Team }
    projects:
      heavy-duty/incubator:
        destination_uuid: dest-abc
projects:
  heavy-duty/incubator:
    environments: [prod]
github_apps: {}
`,
      });
    expect(err).toThrow(
      /environments\.staging\.projects\["heavy-duty\/incubator"\]/,
    );
    expect(err).toThrow(/registered for:\s+prod/);
  });

  it("refuses a binding for a project the registry does not carry at all", () => {
    const err = () =>
      loadBindings("environments.yaml", {
        overrideText: `
environments:
  prod:
    server: shared-box
    team: { id: 0, name: Root Team }
    projects:
      acme/client-site:
        destination_uuid: dest-client
projects:
  heavy-duty/incubator:
    environments: [prod]
github_apps: {}
`,
      });
    expect(err).toThrow(/environments\.prod\.projects\["acme\/client-site"\]/);
    expect(err).toThrow(/registry has:\s+heavy-duty\/incubator/);
  });

  // A legacy bare-<repo> binding key (projectBindingFor still resolves one) under
  // a slug-keyed registry is drift with an obvious fix — say which fix.
  it("tells a legacy bare-<repo> binding key which slug to rename to", () => {
    const err = () =>
      loadBindings("environments.yaml", {
        overrideText: `
environments:
  prod:
    server: shared-box
    team: { id: 0, name: Root Team }
    projects:
      incubator:
        smoke_target: core
projects:
  heavy-duty/incubator:
    environments: [prod]
github_apps: {}
`,
      });
    expect(err).toThrow(/registry has:\s+projects\["heavy-duty\/incubator"\]/);
    expect(err).toThrow(/legacy bare-<repo> key/);
  });

  // No fallback here, unlike github_apps: this block is new, so it has no state
  // files in the wild to keep working, and a bare <repo> is unique only within an
  // org — which is exactly why it is not a key.
  it("refuses a bare <repo> registry key — the org is not optional", () => {
    const err = () =>
      loadBindings("environments.yaml", {
        overrideText: `${twoEnvs}
projects:
  incubator:
    environments: [prod]
github_apps: {}
`,
      });
    expect(err).toThrow(/projects\["incubator"\] is not a repo/);
    expect(err).toThrow(/full <org>\/<repo> slug/);
  });

  // A project registered into nothing is a line of YAML that reads like a
  // registration and is skipped by every fleet run.
  it("refuses a project registered into no environment", () => {
    expect(() =>
      loadBindings("environments.yaml", {
        overrideText: `${twoEnvs}
projects:
  heavy-duty/incubator:
    environments: []
github_apps: {}
`,
      }),
    ).toThrow(/invalid bindings/);
  });

  it("rejects an unknown key inside a registry entry", () => {
    expect(() =>
      loadBindings("environments.yaml", {
        overrideText: `${twoEnvs}
projects:
  heavy-duty/incubator:
    environments: [prod]
    repo: heavy-duty/incubator
github_apps: {}
`,
      }),
    ).toThrow(/invalid bindings/);
  });

  // Back-compat: the registry is optional, and every state file written before it
  // existed has no `projects:` block. Such a file loads unchanged — including its
  // per-environment bindings, which are NOT checked against a registry that is
  // not there.
  describe("with no registry at all", () => {
    const b = loadBindings("environments.yaml", {
      overrideText: `
environments:
  prod:
    server: shared-box
    team: { id: 0, name: Root Team }
    projects:
      heavy-duty/incubator:
        destination_uuid: dest-abc
        smoke_target: core
github_apps: {}
`,
    });

    it("loads, and keeps its per-environment bindings working", () => {
      expect(b.projects).toBe(undefined);
      expect(
        projectBindingFor(b, "prod", "heavy-duty/incubator")?.destination_uuid,
      ).toBe("dest-abc");
    });

    it("has no projects registered in any environment", () => {
      expect(projectsIn(b, "prod")).toEqual([]);
    });
  });
});
