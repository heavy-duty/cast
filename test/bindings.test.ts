import { describe, expect, it } from "vitest";
import { type Bindings, githubAppNameFor } from "../src/bindings.js";

function bindings(github_apps: Record<string, string>): Bindings {
  return {
    environments: {
      prod: { server: "prod-box", team: { id: 0, name: "Root Team" } },
    },
    github_apps,
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
