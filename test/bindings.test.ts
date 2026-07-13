import { describe, expect, it } from "vitest";
import {
  type Bindings,
  type ProjectBinding,
  githubAppNameFor,
  loadBindings,
  projectBindingFor,
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
