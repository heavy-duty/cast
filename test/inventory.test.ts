import { describe, expect, it } from "vitest";
import { absentResources } from "../src/capture.js";
import { reconcile, renderInventory } from "../src/inventory.js";
import type { ManifestResource } from "../src/resolve.js";

const manifest: ManifestResource[] = [
  {
    kind: "application",
    name: "core",
    envKeys: ["NODE_ENV", "DATABASE_URL", "MAILGUN_API_KEY"],
  },
  { kind: "service", name: "umami", envKeys: ["APP_SECRET"] },
  { kind: "database", name: "postgres", envKeys: [] },
];

describe("reconcile", () => {
  it("sorts resources into both / manifest-only / box-only", () => {
    const rec = reconcile(manifest, [
      { kind: "application", name: "core", envKeys: ["NODE_ENV"] },
      { kind: "application", name: "landing", envKeys: [] },
    ]);
    expect(rec.matched.map((m) => m.name)).toEqual(["core"]);
    expect(rec.manifestOnly.map((m) => m.name)).toEqual(["umami", "postgres"]);
    expect(rec.boxOnly.map((l) => l.name)).toEqual(["landing"]);
  });

  it("splits a matched resource's env KEYS the same three ways", () => {
    const rec = reconcile(manifest, [
      {
        kind: "application",
        name: "core",
        envKeys: ["NODE_ENV", "MAILGUN_API_KEY", "LEFTOVER_FROM_2019"],
      },
    ]);
    const core = rec.matched[0];
    expect(core.sharedKeys).toEqual(["MAILGUN_API_KEY", "NODE_ENV"]);
    // The manifest wants it; the box has never heard of it.
    expect(core.manifestOnlyKeys).toEqual(["DATABASE_URL"]);
    // On the box, unknown to the manifest. Either the manifest must gain it or
    // it is cruft that must not travel — the judgment this verb exists to serve.
    expect(core.boxOnlyKeys).toEqual(["LEFTOVER_FROM_2019"]);
  });

  it("matches by name across a kind mismatch rather than hiding it", () => {
    // A manifest `service` the box models as an `application` is the same thing
    // under two vocabularies. Reporting it as manifest-only + box-only would
    // read as "two unrelated resources", which is exactly the wrong conclusion.
    const rec = reconcile(
      [{ kind: "service", name: "umami", envKeys: [] }],
      [{ kind: "application", name: "umami", envKeys: [] }],
    );
    expect(rec.manifestOnly).toEqual([]);
    expect(rec.boxOnly).toEqual([]);
    expect(rec.matched[0].kind).toContain("service");
    expect(rec.matched[0].kind).toContain("application");
  });
});

describe("renderInventory", () => {
  const ctx = {
    orgRepo: "heavy-duty/incubator",
    env: "prod",
    instance: "box-b",
    project: "Incubator",
    environment: "production",
  };

  it("names both sides and every bucket", () => {
    const out = renderInventory(
      reconcile(manifest, [
        {
          kind: "application",
          name: "incubator-stack",
          envKeys: ["MAILGUN_API_KEY"],
        },
      ]),
      ctx,
    );
    // The two names that are NOT ours — the coordinates that made this readable.
    expect(out).toContain("Incubator");
    expect(out).toContain("production");
    // Declared, absent.
    expect(out).toContain("core");
    // Present, undeclared — the finding that a MISSING-per-name report buries.
    expect(out).toContain("incubator-stack");
    expect(out).toContain("This is a document, not desired state");
  });

  it("treats a zero-drift hand-built box as suspicious, not as a pass", () => {
    const out = renderInventory(
      reconcile(
        [{ kind: "application", name: "core", envKeys: [] }],
        [{ kind: "application", name: "core", envKeys: [] }],
      ),
      ctx,
    );
    expect(out).toContain("suspicion rather than relief");
  });
});

describe("absentResources", () => {
  const required = [
    { ref: "MAILGUN_API_KEY", resource: "core", key: "MAILGUN_API_KEY" },
    { ref: "DATABASE_URL_PROD", resource: "core", key: "DATABASE_URL" },
    { ref: "UMAMI_APP_SECRET", resource: "umami", key: "APP_SECRET" },
  ];

  it("names the manifest resources the box does not have", () => {
    expect(absentResources(required, ["incubator-stack", "umami"])).toEqual([
      "core",
    ]);
  });

  it("is empty when every declaring resource exists", () => {
    expect(absentResources(required, ["core", "umami", "landing"])).toEqual([]);
  });

  it("reports each absent resource once, not once per secret it declares", () => {
    // `core` declares two of the three refs. The old failure reported one
    // MISSING per NAME (15 of them, in the live incident) and buried the single
    // fact that mattered: one resource is called something else here.
    expect(absentResources(required, [])).toEqual(["core", "umami"]);
  });
});
