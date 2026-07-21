import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertWritable,
  formatInstance,
  knownInstances,
  loadInstance,
} from "../src/config.js";
import { tmp } from "./helpers/tmp.js";

// A state dir with a default .coolify.env and any number of named instances.
function stateDir(
  named: Record<string, string> = {},
  defaultEnv?: string,
): string {
  const dir = tmp("cast-state-");
  if (defaultEnv !== undefined) {
    writeFileSync(join(dir, ".coolify.env"), defaultEnv);
  }
  if (Object.keys(named).length > 0) {
    mkdirSync(join(dir, ".coolify"));
    for (const [name, body] of Object.entries(named)) {
      writeFileSync(join(dir, ".coolify", `${name}.env`), body);
    }
  }
  return dir;
}

const OK =
  'COOLIFY_BASE_URL="https://cp.example.com"\nCOOLIFY_ACCESS_TOKEN="t"\n';

describe("loadInstance", () => {
  // The whole point of #14 is that adding this must change nothing for anyone
  // who does not use it.
  it("reads .coolify.env when no instance is named — unchanged behavior", () => {
    const dir = stateDir({}, OK);
    const inst = loadInstance(dir);
    expect(inst).toMatchObject({
      name: "default",
      baseUrl: "https://cp.example.com",
      token: "t",
      readOnly: false,
      file: join(dir, ".coolify.env"),
    });
  });

  it("reads .coolify/<name>.env for a named instance", () => {
    const dir = stateDir(
      {
        legacy:
          'COOLIFY_BASE_URL="https://old.example.com"\nCOOLIFY_ACCESS_TOKEN="lt"\n',
      },
      OK,
    );
    expect(loadInstance(dir, "legacy")).toMatchObject({
      name: "legacy",
      baseUrl: "https://old.example.com",
      token: "lt",
    });
  });

  // Refuse, don't guess (#12's position on an absent target, applied to the
  // connection target). Falling back to the default instance here is how a
  // diff meant for a legacy box gets run against production.
  it("refuses an unknown instance and names the ones that exist", () => {
    const dir = stateDir({ "prod-cp": OK, "staging-cp": OK }, OK);
    expect(() => loadInstance(dir, "legacy")).toThrow(
      /no Coolify instance named "legacy"/,
    );
    expect(() => loadInstance(dir, "legacy")).toThrow(/prod-cp, staging-cp/);
  });

  it("says so plainly when no named instances exist at all", () => {
    const dir = stateDir({}, OK);
    expect(() => loadInstance(dir, "legacy")).toThrow(/\(none\)/);
  });

  it("never silently falls back to the default instance", () => {
    const dir = stateDir({}, OK);
    expect(() => loadInstance(dir, "legacy")).toThrow();
  });

  it("reads COOLIFY_READ_ONLY off an instance", () => {
    const dir = stateDir({ legacy: `${OK}COOLIFY_READ_ONLY=true\n` });
    expect(loadInstance(dir, "legacy").readOnly).toBe(true);
  });

  it("still requires base url and token", () => {
    const dir = stateDir({ broken: 'COOLIFY_BASE_URL="https://x"\n' });
    expect(() => loadInstance(dir, "broken")).toThrow(
      /COOLIFY_BASE_URL and COOLIFY_ACCESS_TOKEN are required/,
    );
  });
});

describe("knownInstances", () => {
  it("lists named instances, sorted, and is empty when there are none", () => {
    expect(knownInstances(stateDir({ b: OK, a: OK }, OK))).toEqual(["a", "b"]);
    expect(knownInstances(stateDir({}, OK))).toEqual([]);
  });
});

describe("assertWritable", () => {
  const inst = (readOnly: boolean) => ({
    name: "legacy",
    baseUrl: "https://old.example.com",
    token: "t",
    readOnly,
    file: "/s/.coolify/legacy.env",
  });

  // "I pointed the wrong token at the wrong box" becomes an exit code rather
  // than a live incident — and it holds even when the TOKEN would permit the
  // write. That is the point: the declaration is the guard, not the scope.
  it("refuses a write against a read-only instance, naming the declaration", () => {
    expect(() => assertWritable(inst(true), "apply")).toThrow(
      /refusing to apply.*read-only/s,
    );
    expect(() => assertWritable(inst(true), "apply")).toThrow(
      /COOLIFY_READ_ONLY=true in \/s\/\.coolify\/legacy\.env/,
    );
  });

  it("allows writes against a normal instance", () => {
    expect(() => assertWritable(inst(false), "apply")).not.toThrow();
  });
});

describe("formatInstance", () => {
  it("names the instance and its base url, and flags read-only", () => {
    const base = {
      name: "legacy",
      baseUrl: "https://old.example.com",
      token: "t",
      file: "f",
    };
    expect(formatInstance({ ...base, readOnly: false })).toBe(
      "instance legacy → https://old.example.com",
    );
    expect(formatInstance({ ...base, readOnly: true })).toMatch(/read-only/);
  });
});
