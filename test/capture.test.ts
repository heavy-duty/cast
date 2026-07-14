import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENERATED_PLACEHOLDER,
  classify,
  renderCapturePlan,
} from "../src/capture.js";
import { requiredSecrets } from "../src/resolve.js";

const CTX = {
  orgRepo: "heavy-duty/incubator",
  env: "prod",
  instance: "legacy",
  store: "/s/secrets/incubator.prod.env.age",
  recipient: "age1abc",
};

// The live case, shrunk: an app whose env template needs a generated database
// URL, a carried-over API key, and an address that must NOT be carried over.
const REQUIRED = [
  { ref: "DATABASE_URL_PROD", resource: "core", key: "DATABASE_URL" },
  { ref: "MAILGUN_API_KEY", resource: "core", key: "MAILGUN_API_KEY" },
  { ref: "ADMIN_EMAIL", resource: "core", key: "ADMIN_EMAIL" },
];
const LIVE = {
  core: {
    DATABASE_URL: "postgres://SOURCE-BOX-INTERNAL/db",
    MAILGUN_API_KEY: "key-abc123-REAL-SECRET",
    ADMIN_EMAIL: "founder@real-company.com",
  },
};

describe("classify", () => {
  it("captures a live value, and records where it came from", () => {
    const c = classify([REQUIRED[1]], [], LIVE, {});
    expect(c.plan).toEqual([
      {
        ref: "MAILGUN_API_KEY",
        provenance: "captured",
        value: "key-abc123-REAL-SECRET",
        sites: [{ resource: "core", key: "MAILGUN_API_KEY" }],
      },
    ]);
  });

  // The failure this verb exists to prevent: the source box's DATABASE_URL
  // points at the SOURCE box's Postgres. Copying it over is confidently wrong
  // in a way that looks entirely plausible.
  it("placeholds a generated name, never copying the source's value", () => {
    const c = classify([REQUIRED[0]], ["DATABASE_URL_PROD"], LIVE, {});
    expect(c.plan[0]).toMatchObject({
      ref: "DATABASE_URL_PROD",
      provenance: "generated",
      value: GENERATED_PLACEHOLDER,
    });
    expect(c.plan[0].value).not.toContain("SOURCE-BOX");
  });

  // staging and prod share a Mailgun domain, so a staging box carrying the
  // real ADMIN_EMAIL can mail real users.
  it("takes an override from the operator, over the source's value", () => {
    const c = classify([REQUIRED[2]], [], LIVE, {
      ADMIN_EMAIL: "operator@example.com",
    });
    expect(c.plan[0]).toMatchObject({
      provenance: "overridden",
      value: "operator@example.com",
    });
  });

  it("an override beats a generated declaration too", () => {
    const c = classify([REQUIRED[0]], ["DATABASE_URL_PROD"], LIVE, {
      DATABASE_URL_PROD: "postgres://explicit",
    });
    expect(c.plan[0]).toMatchObject({
      provenance: "overridden",
      value: "postgres://explicit",
    });
  });

  // Required by the template, absent from the source: refuse rather than write
  // an empty. An empty substitutes to nothing and the app boots misconfigured.
  it("refuses on a name required by the template but absent from the source", () => {
    const c = classify(
      [{ ref: "TURNSTILE_SECRET", resource: "core", key: "TURNSTILE_SECRET" }],
      [],
      LIVE,
      {},
    );
    expect(c.plan).toEqual([]);
    expect(c.missing).toEqual([
      {
        ref: "TURNSTILE_SECRET",
        sites: [{ resource: "core", key: "TURNSTILE_SECRET" }],
      },
    ]);
  });

  it("a missing name can be rescued by an override", () => {
    const c = classify(
      [{ ref: "TURNSTILE_SECRET", resource: "core", key: "TURNSTILE_SECRET" }],
      [],
      LIVE,
      { TURNSTILE_SECRET: "supplied" },
    );
    expect(c.missing).toEqual([]);
    expect(c.plan[0].provenance).toBe("overridden");
  });

  // One name, two resources, two different live values. The store holds one
  // value per name; picking wrong would be silent.
  it("refuses when one name carries different values on two resources", () => {
    const c = classify(
      [
        { ref: "SHARED", resource: "core", key: "SHARED" },
        { ref: "SHARED", resource: "worker", key: "SHARED" },
      ],
      [],
      { core: { SHARED: "a" }, worker: { SHARED: "b" } },
      {},
    );
    expect(c.plan).toEqual([]);
    expect(c.conflicts).toEqual([
      {
        ref: "SHARED",
        values: [
          { resource: "core", key: "SHARED" },
          { resource: "worker", key: "SHARED" },
        ],
      },
    ]);
  });

  it("is fine when one name carries the SAME value on two resources", () => {
    const c = classify(
      [
        { ref: "SHARED", resource: "core", key: "SHARED" },
        { ref: "SHARED", resource: "worker", key: "SHARED" },
      ],
      [],
      { core: { SHARED: "same" }, worker: { SHARED: "same" } },
      {},
    );
    expect(c.conflicts).toEqual([]);
    expect(c.plan[0].value).toBe("same");
  });

  // The acceptance criterion: exactly the names the manifest requires, no more
  // and no fewer. A live var the manifest does not ask for is not the store's
  // business.
  it("writes exactly the required names — ignoring live vars nobody asked for", () => {
    const c = classify(
      REQUIRED,
      ["DATABASE_URL_PROD"],
      {
        core: { ...LIVE.core, SOME_OTHER_LIVE_VAR: "not in the manifest" },
      },
      {},
    );
    expect(c.plan.map((d) => d.ref).sort()).toEqual([
      "ADMIN_EMAIL",
      "DATABASE_URL_PROD",
      "MAILGUN_API_KEY",
    ]);
  });
});

describe("renderCapturePlan", () => {
  // THE invariant. "No secret value is ever written to stdout" — so the plan
  // is names and provenance, and the test asserts on the actual live values
  // rather than on a pattern that could drift away from them.
  it("never prints a secret value", () => {
    const c = classify(REQUIRED, ["DATABASE_URL_PROD"], LIVE, {
      ADMIN_EMAIL: "operator@example.com",
    });
    const out = renderCapturePlan(c, CTX);
    for (const secret of [
      "postgres://SOURCE-BOX-INTERNAL/db",
      "key-abc123-REAL-SECRET",
      "founder@real-company.com",
      "operator@example.com",
    ]) {
      expect(out).not.toContain(secret);
    }
  });

  it("shows every name with its provenance and where it lands", () => {
    const c = classify(REQUIRED, ["DATABASE_URL_PROD"], LIVE, {
      ADMIN_EMAIL: "operator@example.com",
    });
    const out = renderCapturePlan(c, CTX);
    expect(out).toMatch(/MAILGUN_API_KEY\s+captured\s+core\.MAILGUN_API_KEY/);
    expect(out).toMatch(/DATABASE_URL_PROD\s+generated/);
    expect(out).toContain(GENERATED_PLACEHOLDER);
    expect(out).toMatch(/ADMIN_EMAIL\s+overridden/);
    expect(out).toContain("CAST_CAPTURE_ADMIN_EMAIL");
    expect(out).toMatch(/3 name\(s\) to write/);
    expect(out).toContain("/s/secrets/incubator.prod.env.age");
    expect(out).toContain("age1abc");
  });

  it("names what is missing, and says why an empty would be worse", () => {
    const c = classify(
      [{ ref: "TURNSTILE_SECRET", resource: "core", key: "TURNSTILE_SECRET" }],
      [],
      LIVE,
      {},
    );
    const out = renderCapturePlan(c, CTX);
    expect(out).toMatch(/TURNSTILE_SECRET\s+MISSING/);
    expect(out).toMatch(/refusing to write the store/);
    expect(out).toMatch(/--override/);
  });

  it("names a conflict rather than picking a side", () => {
    const c = classify(
      [
        { ref: "SHARED", resource: "core", key: "SHARED" },
        { ref: "SHARED", resource: "worker", key: "SHARED" },
      ],
      [],
      { core: { SHARED: "a" }, worker: { SHARED: "b" } },
      {},
    );
    const out = renderCapturePlan(c, CTX);
    expect(out).toMatch(/SHARED\s+CONFLICT/);
    expect(out).toMatch(/core\.SHARED and worker\.SHARED/);
    expect(out).not.toMatch(/\ba\b.*\bb\b/);
  });
});

// requiredSecrets is what makes "no more, no fewer" true: the set comes from
// the manifest's own templates, read by the same parser apply uses.
describe("requiredSecrets", () => {
  function checkout(manifest: string, templates: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), "cast-cap-"));
    mkdirSync(join(dir, ".infra", "env"), { recursive: true });
    writeFileSync(join(dir, ".infra", "manifest.yaml"), manifest);
    for (const [name, body] of Object.entries(templates)) {
      writeFileSync(join(dir, ".infra", "env", name), body);
    }
    return dir;
  }

  const MANIFEST = `project: incubator
environments:
  prod:
    generated_secrets: [DATABASE_URL_PROD]
    applications:
      core:
        source: { repo: heavy-duty/incubator, branch: main }
        build: { pack: dockercompose, base_directory: /, compose_file: /docker-compose.yaml }
        service_domains:
          api: ["https://api.example.com"]
        env_template: core.prod.env.template
    services:
      umami:
        type: umami
        env_template: umami.prod.env.template
`;

  it("collects the ${...} refs from every app and service template", () => {
    const dir = checkout(MANIFEST, {
      "core.prod.env.template":
        "NODE_ENV=production\nDATABASE_URL=${DATABASE_URL_PROD}\nMAILGUN_API_KEY=${MAILGUN_API_KEY}\n",
      "umami.prod.env.template": "APP_SECRET=${UMAMI_APP_SECRET}\n",
    });
    const { required, generated } = requiredSecrets(dir, "prod");
    expect(required).toEqual([
      { ref: "DATABASE_URL_PROD", resource: "core", key: "DATABASE_URL" },
      { ref: "MAILGUN_API_KEY", resource: "core", key: "MAILGUN_API_KEY" },
      { ref: "UMAMI_APP_SECRET", resource: "umami", key: "APP_SECRET" },
    ]);
    expect(generated).toEqual(["DATABASE_URL_PROD"]);
  });

  // A non-placeholder line (NODE_ENV=production) is not a secret and must not
  // land in the store — the store holds the ${...} refs, nothing else.
  it("ignores literal template values — only ${...} refs are secrets", () => {
    const dir = checkout(MANIFEST, {
      "core.prod.env.template":
        "NODE_ENV=production\nREPORTING_ENABLED=false\nDATABASE_URL=${DATABASE_URL_PROD}\n",
      "umami.prod.env.template": "",
    });
    const { required } = requiredSecrets(dir, "prod");
    expect(required.map((r) => r.ref)).toEqual(["DATABASE_URL_PROD"]);
  });

  // Dead config in THIS list is dangerous, not merely untidy: it reads like a
  // guard standing over a name while standing over nothing, and the likeliest
  // cause is a typo whose real name is then CAPTURED from the source box.
  it("refuses a generated_secrets entry that no template refers to", () => {
    const dir = checkout(
      MANIFEST.replace(
        "generated_secrets: [DATABASE_URL_PROD]",
        "generated_secrets: [DATABASE_URL_TYPO]",
      ),
      {
        "core.prod.env.template": "DATABASE_URL=${DATABASE_URL_PROD}\n",
        "umami.prod.env.template": "",
      },
    );
    expect(() => requiredSecrets(dir, "prod")).toThrow(
      /generated_secrets names DATABASE_URL_TYPO/,
    );
  });
});
