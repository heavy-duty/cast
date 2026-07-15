import { describe, expect, it } from "vitest";
import {
  DERIVED_UNRESOLVED,
  DOMAIN_UNRESOLVED,
  assertEnvVarPolicy,
  fillDerivedEnv,
  fillDomainEnv,
  resolveTemplate,
  templateDomainRefs,
  templateRefs,
  templateResourceRefs,
  unresolvedDerived,
} from "../src/envtemplate.js";

describe("resolveTemplate", () => {
  it("classifies literals as non-secret and ${…} as secret", () => {
    const r = resolveTemplate(
      "PORT=3000\nMAILGUN_KEY=${MAILGUN_KEY}\n# comment\n\n",
      {
        MAILGUN_KEY: "mk-123",
      },
    );
    expect(r.vars.PORT).toEqual({ value: "3000", secret: false });
    expect(r.vars.MAILGUN_KEY).toEqual({ value: "mk-123", secret: true });
  });
  it("throws on a missing secret, naming key and placeholder", () => {
    expect(() => resolveTemplate("API_KEY=${NOPE}", {})).toThrow(
      /NOPE.*API_KEY|API_KEY.*NOPE/,
    );
  });
  it("throws on malformed lines with the line number", () => {
    expect(() => resolveTemplate("PORT=3000\nnot a line", {})).toThrow(
      /line 2/,
    );
  });
});

describe("assertEnvVarPolicy", () => {
  const withFlag = { vars: { ALLOW_SEED: { value: "false", secret: false } } };
  const banAllow = ["^ALLOW_"];

  it("refuses when a forbidden var is PRESENT, even set false", () => {
    expect(() =>
      assertEnvVarPolicy("prod", { "core-api": withFlag }, banAllow),
    ).toThrow(/ALLOW_SEED.*core-api.*off.*absent/s);
  });
  it("allows the same env where the policy is not declared", () => {
    expect(() =>
      assertEnvVarPolicy("staging", { "core-api": withFlag }, undefined),
    ).not.toThrow();
  });
  it("is a pattern, not a fixed list — it catches unforeseen siblings", () => {
    const future = {
      vars: { ALLOW_WIPE_EVERYTHING: { value: "true", secret: false } },
    };
    expect(() =>
      assertEnvVarPolicy("prod", { worker: future }, banAllow),
    ).toThrow(/ALLOW_WIPE_EVERYTHING/);
  });
  it("leaves vars that do not match the pattern alone", () => {
    const ok = { vars: { PORT: { value: "3000", secret: false } } };
    expect(() =>
      assertEnvVarPolicy("prod", { "core-api": ok }, banAllow),
    ).not.toThrow();
  });
});

describe("derived resource refs (#60)", () => {
  const template =
    "PORT=3000\nMAILGUN_KEY=${MAILGUN_KEY}\nDATABASE_URL=${resource:postgres.url}\n";

  it("resolveTemplate marks a ${resource:…} var derived and UNRESOLVED, not secret-missing", () => {
    // No store entry for it, and yet it does not throw the way a missing secret
    // does: a derived value is not in the store to be missing FROM.
    const r = resolveTemplate(template, { MAILGUN_KEY: "mk" });
    expect(r.vars.DATABASE_URL).toEqual({
      value: DERIVED_UNRESOLVED,
      secret: true,
      derived: { resource: "postgres", attr: "url" },
    });
    // The secret and the literal are untouched by the new branch.
    expect(r.vars.MAILGUN_KEY).toEqual({ value: "mk", secret: true });
    expect(r.vars.PORT).toEqual({ value: "3000", secret: false });
  });

  it("templateResourceRefs reports the edge; templateRefs does NOT treat it as a secret", () => {
    expect(templateResourceRefs(template)).toEqual([
      { key: "DATABASE_URL", resource: "postgres", attr: "url" },
    ]);
    // capture reads templateRefs — a derived edge must never appear there, or it
    // would go hunting for a store name called `resource:postgres.url`.
    expect(templateRefs(template).map((r) => r.key)).toEqual(["MAILGUN_KEY"]);
  });

  it("fillDerivedEnv resolves against a URL map and leaves the rest alone", () => {
    const env = resolveTemplate(template, { MAILGUN_KEY: "mk" });
    const filled = fillDerivedEnv(env, {
      postgres: "postgres://u:p@uuid:5432/db",
    });
    expect(filled.vars.DATABASE_URL).toEqual({
      value: "postgres://u:p@uuid:5432/db",
      secret: true,
      derived: { resource: "postgres", attr: "url" },
    });
    expect(unresolvedDerived(filled)).toEqual([]);
  });

  it("fillDerivedEnv leaves a ref whose resource is absent (or empty) unresolved", () => {
    const env = resolveTemplate(template, { MAILGUN_KEY: "mk" });
    // Absent from the map, and present-but-empty, are both non-resolutions — an
    // empty URL must never be written (it boots the app pointed at nothing).
    expect(unresolvedDerived(fillDerivedEnv(env, {}))).toEqual([
      { key: "DATABASE_URL", resource: "postgres" },
    ]);
    expect(unresolvedDerived(fillDerivedEnv(env, { postgres: "" }))).toEqual([
      { key: "DATABASE_URL", resource: "postgres" },
    ]);
  });
});

describe("derived domain refs (#66)", () => {
  const template =
    "PORT=3000\nMAILGUN_KEY=${MAILGUN_KEY}\nDATABASE_URL=${resource:postgres.url}\nLANDING_BASE_URL=${domain:landing}\nADMIN_WEB_BASE_URL=${domain:core.admin}\n";

  it("resolveTemplate marks a ${domain:…} var with its ref, secret:false, and the transient sentinel — never the literal", () => {
    const r = resolveTemplate(template, { MAILGUN_KEY: "mk" });
    // An app ref and an app.service ref, both carrying the sentinel and the ref,
    // both public (secret:false) — and NOT written through as the literal text.
    expect(r.vars.LANDING_BASE_URL).toEqual({
      value: DOMAIN_UNRESOLVED,
      secret: false,
      domain: { app: "landing" },
    });
    expect(r.vars.ADMIN_WEB_BASE_URL).toEqual({
      value: DOMAIN_UNRESOLVED,
      secret: false,
      domain: { app: "core", service: "admin" },
    });
    expect(r.vars.LANDING_BASE_URL.value).not.toContain("${domain:");
    // The three ref kinds stay mutually exclusive, and the plain secret/literal
    // are untouched by the new branch.
    expect(r.vars.DATABASE_URL).toEqual({
      value: DERIVED_UNRESOLVED,
      secret: true,
      derived: { resource: "postgres", attr: "url" },
    });
    expect(r.vars.MAILGUN_KEY).toEqual({ value: "mk", secret: true });
    expect(r.vars.PORT).toEqual({ value: "3000", secret: false });
  });

  it("fillDomainEnv resolves app and app.service refs verbatim, secret:false, marker dropped", () => {
    const env = resolveTemplate(template, { MAILGUN_KEY: "mk" });
    const filled = fillDomainEnv(env, {
      landing: "https://new.heavyduty.builders",
      "core.admin": "https://admin.heavyduty.builders",
    });
    // Resolved to the verbatim domain (scheme and all), public, and with the
    // `domain` marker DROPPED — indistinguishable from a literal downstream.
    expect(filled.vars.LANDING_BASE_URL).toEqual({
      value: "https://new.heavyduty.builders",
      secret: false,
    });
    expect(filled.vars.ADMIN_WEB_BASE_URL).toEqual({
      value: "https://admin.heavyduty.builders",
      secret: false,
    });
    // The non-domain vars ride through untouched.
    expect(filled.vars.MAILGUN_KEY).toEqual({ value: "mk", secret: true });
    expect(filled.vars.DATABASE_URL.value).toBe(DERIVED_UNRESOLVED);
  });

  it("fillDomainEnv leaves an unknown key as-is (sentinel and marker intact)", () => {
    const env = resolveTemplate("X=${domain:landing}\n", {});
    // Absent from the map, and present-but-empty, are both non-resolutions.
    expect(fillDomainEnv(env, {}).vars.X).toEqual({
      value: DOMAIN_UNRESOLVED,
      secret: false,
      domain: { app: "landing" },
    });
    expect(fillDomainEnv(env, { landing: "" }).vars.X).toEqual({
      value: DOMAIN_UNRESOLVED,
      secret: false,
      domain: { app: "landing" },
    });
  });

  it("templateDomainRefs extracts the edges; templateRefs/templateResourceRefs exclude them", () => {
    expect(templateDomainRefs(template)).toEqual([
      { key: "LANDING_BASE_URL", app: "landing" },
      { key: "ADMIN_WEB_BASE_URL", app: "core", service: "admin" },
    ]);
    // A domain is not a secret to capture, and not a resource edge either.
    expect(templateRefs(template).map((r) => r.key)).toEqual(["MAILGUN_KEY"]);
    expect(templateResourceRefs(template).map((r) => r.key)).toEqual([
      "DATABASE_URL",
    ]);
  });
});
