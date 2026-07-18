import { execFile, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

// The layout verbs — cast versions / use / uninstall — exercised on REAL
// installed sandboxes: two versions land via the real install.sh (npm
// shimmed, as in install-sh.test.ts), then every verb runs through the PATH
// chain the way an operator's would. Assertions read symlinks and trees,
// plus each refusal's exit code and message.

const INSTALL_SH = join(process.cwd(), "install.sh");
const REAL_BIN_CAST = join(process.cwd(), "bin", "cast");

const FAKE_CLI = `const path = require("path");
const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const [cmd] = process.argv.slice(2);
if (cmd === "--version" || cmd === "-V") {
  console.log("cast " + pkg.version + " (" + root + ")");
  process.exit(0);
}
console.log("fake-cast " + pkg.version);
`;

const NPM_SHIM = `#!/usr/bin/env bash
case "\${1:-}" in
  run) mkdir -p dist && cp "$CAST_TEST_FAKECLI" dist/cli.js ;;
esac
`;

type Sandbox = {
  root: string;
  dest: string;
  bindir: string;
  env: Record<string, string>;
};

async function installedSandbox(versions: string[]): Promise<Sandbox> {
  const root = mkdtempSync(join(tmpdir(), "cast-layout-"));
  const stubs = join(root, "stubs");
  const home = join(root, "home");
  const dest = join(root, "cast-home");
  const bindir = join(root, "bin");
  mkdirSync(stubs);
  mkdirSync(home);
  const fakeCli = join(root, "fake-cli.js");
  writeFileSync(fakeCli, FAKE_CLI);
  writeFileSync(join(stubs, "npm"), NPM_SHIM);
  chmodSync(join(stubs, "npm"), 0o755);
  const env = {
    PATH: `${stubs}:${process.env.PATH}`,
    HOME: home,
    SHELL: "/bin/bash",
    CAST_HOME: dest,
    CAST_BIN: bindir,
    CAST_NO_MODIFY_PATH: "1",
    CAST_TEST_FAKECLI: fakeCli,
  };
  for (const version of versions) {
    const src = join(root, `src-${version}`);
    mkdirSync(join(src, "bin"), { recursive: true });
    copyFileSync(REAL_BIN_CAST, join(src, "bin", "cast"));
    writeFileSync(
      join(src, "package.json"),
      `${JSON.stringify({ name: "cast", version })}\n`,
    );
    await run("bash", [INSTALL_SH], {
      env: { ...env, CAST_INSTALL_SOURCE: src },
    });
  }
  return { root, dest, bindir, env };
}

// Through the chain, like an operator: $BINDIR/cast -> current -> version.
async function cast(
  sb: Sandbox,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  return run(join(sb.bindir, "cast"), args, {
    env: { ...sb.env, ...extraEnv },
  });
}

function currentVersion(sb: Sandbox): string {
  return realpathSync(join(sb.dest, "current")).split("/").pop() ?? "";
}

describe("cast versions", () => {
  it("lists installed versions, marking (current) and (running)", async () => {
    const sb = await installedSandbox(["0.5.0", "0.6.0"]);
    const { stdout } = await cast(sb, ["versions"]);
    // 0.6.0 installed last, so it is the default — and, invoked through the
    // chain, also the tree answering this very command.
    expect(stdout).toContain(`VERSIONS  (${sb.dest}`);
    expect(stdout).toMatch(/^ {2}0\.5\.0$/m);
    expect(stdout).toMatch(/^ {2}0\.6\.0 \(current\) \(running\)$/m);
    expect(stdout).toContain("switch the default:  cast use <version>");
  });

  it("refuses to run from a working tree — this repo checkout is not an install", async () => {
    await expect(run(REAL_BIN_CAST, ["versions"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("not a versioned install"),
    });
  });
});

describe("cast use", () => {
  it("switches the default atomically and asserts the chain answers the new version", async () => {
    const sb = await installedSandbox(["0.5.0", "0.6.0"]);
    expect(currentVersion(sb)).toBe("0.6.0");

    const { stdout } = await cast(sb, ["use", "0.5.0"]);
    expect(stdout).toContain("switched to 0.5.0 (current -> versions/0.5.0)");
    expect(currentVersion(sb)).toBe("0.5.0");
    const { stdout: v } = await cast(sb, ["--version"]);
    expect(v).toContain("cast 0.5.0");
  });

  it("refuses a version that is not installed, an insane name, and a missing argument", async () => {
    const sb = await installedSandbox(["0.5.0"]);
    await expect(cast(sb, ["use", "9.9.9"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("no such version: 9.9.9"),
    });
    // The gate fires BEFORE any path is built from the name.
    await expect(cast(sb, ["use", "../evil"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("not a sane version name: '../evil'"),
    });
    await expect(cast(sb, ["use"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("use needs a version"),
    });
  });
});

describe("cast uninstall", () => {
  it("removes one non-current version and proves the absence", async () => {
    const sb = await installedSandbox(["0.5.0", "0.6.0"]);
    const { stdout } = await cast(sb, ["uninstall", "0.5.0"], {
      CAST_YES: "1",
    });
    expect(stdout).toContain("removed version 0.5.0 (the default stays 0.6.0)");
    expect(existsSync(join(sb.dest, "versions/0.5.0"))).toBe(false);
    expect(currentVersion(sb)).toBe("0.6.0");
  });

  it("refuses to remove the CURRENT version", async () => {
    const sb = await installedSandbox(["0.5.0", "0.6.0"]);
    await expect(
      cast(sb, ["uninstall", "0.6.0"], { CAST_YES: "1" }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("0.6.0 is the CURRENT version"),
    });
    expect(existsSync(join(sb.dest, "versions/0.6.0"))).toBe(true);
  });

  it("refuses without consent when there is no terminal to confirm on", async () => {
    const sb = await installedSandbox(["0.5.0", "0.6.0"]);
    // No CAST_YES, no --force, stdin is a pipe — the consent contract says
    // refuse rather than assume.
    const result = await new Promise<{ code: number; stderr: string }>(
      (resolve) => {
        const child = spawn(join(sb.bindir, "cast"), ["uninstall", "0.5.0"], {
          env: sb.env,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (d) => {
          stderr += String(d);
        });
        child.on("close", (code) => resolve({ code: code ?? 0, stderr }));
      },
    );
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("refusing to remove cast version 0.5.0");
    expect(existsSync(join(sb.dest, "versions/0.5.0"))).toBe(true);
  });

  it("--all removes every version, current, and the PATH symlink — then re-checks", async () => {
    const sb = await installedSandbox(["0.5.0", "0.6.0"]);
    const { stdout } = await cast(sb, ["uninstall", "--all"], {
      CAST_YES: "1",
    });
    expect(stdout).toContain("uninstalled — removed:");
    expect(existsSync(sb.dest)).toBe(false);
    // The PATH symlink resolved into this install root, so it went too —
    // as a link, not just as a resolvable file.
    expect(existsSync(join(sb.bindir, "cast"))).toBe(false);
    const gone = await run("bash", [
      "-c",
      `[ ! -L '${join(sb.bindir, "cast")}' ] && echo really-gone`,
    ]);
    expect(gone.stdout.trim()).toBe("really-gone");
  });

  it("a version plus --all is ambiguous, and unknown options are refused", async () => {
    const sb = await installedSandbox(["0.5.0"]);
    await expect(
      cast(sb, ["uninstall", "0.5.0", "--all"], { CAST_YES: "1" }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("ambiguous"),
    });
    await expect(
      cast(sb, ["uninstall", "--purge"], { CAST_YES: "1" }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("unknown option: --purge"),
    });
  });
});
