import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runCli(args: string[]): { code: number; output: string } {
  try {
    const output = execFileSync("node", ["dist/cli.js", ...args], {
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output };
  } catch (e) {
    const err = e as { status: number; stderr: string; stdout: string };
    return { code: err.status, output: `${err.stdout}${err.stderr}` };
  }
}

describe("infra cli", () => {
  it("refuses apply --path with --env prod, exit non-zero", () => {
    const r = runCli([
      "apply",
      "acme/widget",
      "--env",
      "prod",
      "--path",
      "/tmp/x",
    ]);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/--path.*prod/);
  });
  it("prints usage on unknown command", () => {
    const r = runCli(["frobnicate"]);
    expect(r.code).not.toBe(0);
    expect(r.output).toMatch(/usage: cast (apply|diff)/i);
  });
});
