import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

// These tests drive the REAL install.sh — not a reimplementation of its
// logic — via CAST_INSTALL_SOURCE (the offline channel the installer carries
// for exactly this, rig's RIG_INSTALL_SOURCE precedent) and an npm PATH shim
// whose `run build` drops a tiny runnable cli.js. Every assertion reads the
// resulting tree, the symlink chain, or the shim's invocation log. The real
// npm-ci-and-tsc build path runs end to end in CI's install job instead —
// here it would cost minutes per test for no extra layout coverage.

const INSTALL_SH = join(process.cwd(), "install.sh");
const REAL_BIN_CAST = join(process.cwd(), "bin", "cast");

// What `npm run build` produces in a fixture tree: enough of a cli.js that
// the launcher chain — BINDIR/cast -> current -> versions/<v>/bin/cast ->
// node dist/cli.js — can be asserted end to end, --version included (cmd_use
// verifies the flip through it).
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
printf 'npm %s\\n' "$*" >> "$CAST_TEST_NPM_LOG"
case "\${1:-}" in
  run) mkdir -p dist && cp "$CAST_TEST_FAKECLI" dist/cli.js ;;
esac
`;

type Sandbox = {
  root: string;
  dest: string;
  bindir: string;
  npmLog: string;
  env: Record<string, string>;
};

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "cast-install-"));
  const stubs = join(root, "stubs");
  const home = join(root, "home");
  const dest = join(root, "cast-home");
  const bindir = join(root, "bin");
  mkdirSync(stubs);
  mkdirSync(home);
  const npmLog = join(root, "npm.log");
  const fakeCli = join(root, "fake-cli.js");
  writeFileSync(npmLog, "");
  writeFileSync(fakeCli, FAKE_CLI);
  writeFileSync(join(stubs, "npm"), NPM_SHIM);
  chmodSync(join(stubs, "npm"), 0o755);
  return {
    root,
    dest,
    bindir,
    npmLog,
    env: {
      PATH: `${stubs}:${process.env.PATH}`,
      HOME: home,
      SHELL: "/bin/bash",
      CAST_HOME: dest,
      CAST_BIN: bindir,
      CAST_NO_MODIFY_PATH: "1",
      CAST_TEST_NPM_LOG: npmLog,
      CAST_TEST_FAKECLI: fakeCli,
    },
  };
}

// A source tree the installer can build: the REPO'S OWN bin/cast (so the
// launcher and its layout verbs are the code under review), a package.json
// carrying the version, and a src/ marker.
function sourceTree(sb: Sandbox, version: string): string {
  const src = join(sb.root, `src-${version.replace(/[^A-Za-z0-9.]/g, "_")}`);
  mkdirSync(join(src, "bin"), { recursive: true });
  mkdirSync(join(src, "src"), { recursive: true });
  copyFileSync(REAL_BIN_CAST, join(src, "bin", "cast"));
  writeFileSync(
    join(src, "package.json"),
    `${JSON.stringify({ name: "cast", version })}\n`,
  );
  writeFileSync(join(src, "src", "cli.ts"), "// fixture\n");
  return src;
}

async function install(sb: Sandbox, extraEnv: Record<string, string>) {
  return run("bash", [INSTALL_SH], { env: { ...sb.env, ...extraEnv } });
}

function currentTarget(sb: Sandbox): string {
  return realpathSync(join(sb.dest, "current"));
}

describe("install.sh — the versioned layout", () => {
  it("lands versions/<v>, points current and the PATH link through it, and the chain answers", async () => {
    const sb = sandbox();
    const src = sourceTree(sb, "0.5.0");
    const { stdout } = await install(sb, { CAST_INSTALL_SOURCE: src });

    expect(stdout).toContain("done (local source");
    // The layout: one tree per version, named by package.json's version.
    expect(existsSync(join(sb.dest, "versions/0.5.0/bin/cast"))).toBe(true);
    expect(
      readFileSync(join(sb.dest, "versions/0.5.0/dist/cli.js"), "utf8"),
    ).toContain("pkg.version");
    expect(
      readFileSync(join(sb.dest, "versions/0.5.0/INSTALLED_FROM"), "utf8"),
    ).toBe(`local:${src}\n`);
    // The chain: current -> versions/0.5.0, BINDIR/cast -> current/bin/cast.
    expect(currentTarget(sb)).toBe(
      realpathSync(join(sb.dest, "versions/0.5.0")),
    );
    expect(readlinkSync(join(sb.bindir, "cast"))).toBe(
      join(sb.dest, "current/bin/cast"),
    );
    // And it ANSWERS, through the whole chain.
    const { stdout: v } = await run(join(sb.bindir, "cast"), ["--version"], {
      env: sb.env,
    });
    expect(v.trim()).toBe(
      `cast 0.5.0 (${realpathSync(join(sb.dest, "versions/0.5.0"))})`,
    );
    // The build ran: ci, build, prune — in that order.
    expect(readFileSync(sb.npmLog, "utf8")).toBe(
      "npm ci --silent\nnpm run build --silent\nnpm prune --omit=dev --silent\n",
    );
  });

  it("re-running the same version is a converging no-op — nothing rebuilt, nothing touched", async () => {
    const sb = sandbox();
    const src = sourceTree(sb, "0.5.0");
    await install(sb, { CAST_INSTALL_SOURCE: src });
    const npmCallsAfterFirst = readFileSync(sb.npmLog, "utf8");
    writeFileSync(join(sb.dest, "versions/0.5.0/SENTINEL"), "survives\n");

    const { stdout } = await install(sb, { CAST_INSTALL_SOURCE: src });
    expect(stdout).toContain("cast 0.5.0 is already installed");
    expect(stdout).toContain("nothing was built");
    // No second build, and the installed tree was not replaced.
    expect(readFileSync(sb.npmLog, "utf8")).toBe(npmCallsAfterFirst);
    expect(readFileSync(join(sb.dest, "versions/0.5.0/SENTINEL"), "utf8")).toBe(
      "survives\n",
    );
  });

  it("CAST_REINSTALL=1 replaces that version's tree — no partial overlays", async () => {
    const sb = sandbox();
    const src = sourceTree(sb, "0.5.0");
    await install(sb, { CAST_INSTALL_SOURCE: src });
    writeFileSync(join(sb.dest, "versions/0.5.0/SENTINEL"), "stale\n");

    const { stdout } = await install(sb, {
      CAST_INSTALL_SOURCE: src,
      CAST_REINSTALL: "1",
    });
    expect(stdout).toContain("replacing the installed 0.5.0 tree");
    // A replaced tree, not an overlay: the stale file is gone.
    expect(existsSync(join(sb.dest, "versions/0.5.0/SENTINEL"))).toBe(false);
    expect(existsSync(join(sb.dest, "versions/0.5.0/dist/cli.js"))).toBe(true);
  });

  it("a NEW version installs beside the old one and becomes the default", async () => {
    const sb = sandbox();
    await install(sb, { CAST_INSTALL_SOURCE: sourceTree(sb, "0.5.0") });
    const { stdout } = await install(sb, {
      CAST_INSTALL_SOURCE: sourceTree(sb, "0.6.0"),
    });

    expect(stdout).toContain(
      "default version switched: 0.5.0 -> 0.6.0 ('cast use 0.5.0' switches back)",
    );
    expect(existsSync(join(sb.dest, "versions/0.5.0/bin/cast"))).toBe(true);
    expect(currentTarget(sb)).toBe(
      realpathSync(join(sb.dest, "versions/0.6.0")),
    );
    const { stdout: v } = await run(join(sb.bindir, "cast"), ["--version"], {
      env: sb.env,
    });
    expect(v).toContain("cast 0.6.0");
  });

  it("re-running an installed NON-default version never moves the default", async () => {
    const sb = sandbox();
    const old = sourceTree(sb, "0.5.0");
    await install(sb, { CAST_INSTALL_SOURCE: old });
    await install(sb, { CAST_INSTALL_SOURCE: sourceTree(sb, "0.6.0") });

    const { stdout } = await install(sb, { CAST_INSTALL_SOURCE: old });
    expect(stdout).toContain(
      "the default stays 0.6.0 — 'cast use 0.5.0' switches.",
    );
    expect(currentTarget(sb)).toBe(
      realpathSync(join(sb.dest, "versions/0.6.0")),
    );
  });

  it("migrates a pre-versioning flat install in place, preserving the tree", async () => {
    const sb = sandbox();
    // The OLD layout: the tree sits flat at $DEST, bin/cast directly under it.
    mkdirSync(join(sb.dest, "bin"), { recursive: true });
    mkdirSync(join(sb.dest, "dist"), { recursive: true });
    copyFileSync(REAL_BIN_CAST, join(sb.dest, "bin/cast"));
    writeFileSync(
      join(sb.dest, "package.json"),
      `${JSON.stringify({ name: "cast", version: "0.4.0" })}\n`,
    );
    writeFileSync(
      join(sb.dest, "SENTINEL"),
      "the operator's tree, bit for bit\n",
    );

    const { stdout } = await install(sb, {
      CAST_INSTALL_SOURCE: sourceTree(sb, "0.5.0"),
    });
    expect(stdout).toContain("found a pre-versioning flat install at");
    expect(stdout).toContain("migrating it into the versioned layout");
    // The flat tree moved — preserved, not rebuilt — and the new version
    // installed beside it and took the default.
    expect(readFileSync(join(sb.dest, "versions/0.4.0/SENTINEL"), "utf8")).toBe(
      "the operator's tree, bit for bit\n",
    );
    expect(existsSync(join(sb.dest, "versions/0.5.0/bin/cast"))).toBe(true);
    expect(currentTarget(sb)).toBe(
      realpathSync(join(sb.dest, "versions/0.5.0")),
    );
  });

  it("refuses a source whose package.json version is not a sane directory name", async () => {
    const sb = sandbox();
    const src = sourceTree(sb, "../evil");
    await expect(
      install(sb, { CAST_INSTALL_SOURCE: src }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("not a sane directory name: '../evil'"),
    });
    expect(existsSync(sb.dest)).toBe(false);
  });

  it("refuses to migrate a flat install whose version would escape versions/", async () => {
    const sb = sandbox();
    mkdirSync(join(sb.dest, "bin"), { recursive: true });
    copyFileSync(REAL_BIN_CAST, join(sb.dest, "bin/cast"));
    writeFileSync(
      join(sb.dest, "package.json"),
      `${JSON.stringify({ name: "cast", version: "../evil" })}\n`,
    );

    await expect(
      install(sb, { CAST_INSTALL_SOURCE: sourceTree(sb, "0.5.0") }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("not a sane directory name"),
    });
    // Refused BEFORE anything moved: the flat tree is untouched.
    expect(existsSync(join(sb.dest, "bin/cast"))).toBe(true);
  });

  it("downloads refs/heads/<ref> when no local source is given", async () => {
    const sb = sandbox();
    // A curl shim standing in for GitHub: serves the fixture tarball and
    // logs the URL it was asked for.
    sourceTree(sb, "0.5.0");
    await run("tar", [
      "-C",
      sb.root,
      "-czf",
      join(sb.root, "src.tgz"),
      "src-0.5.0",
    ]);
    const stubs = join(sb.root, "stubs");
    const curlLog = join(sb.root, "curl.log");
    writeFileSync(curlLog, "");
    writeFileSync(
      join(stubs, "curl"),
      `#!/usr/bin/env bash
out=""; url=""
for a in "$@"; do
  case "$prev" in -o) out="$a" ;; esac
  case "$a" in http*) url="$a" ;; esac
  prev="$a"
done
printf '%s\\n' "$url" >> "${curlLog}"
cp "${join(sb.root, "src.tgz")}" "$out"
`,
    );
    chmodSync(join(stubs, "curl"), 0o755);

    const { stdout } = await install(sb, { CAST_REF: "dev-branch" });
    expect(readFileSync(curlLog, "utf8").trim()).toBe(
      "https://github.com/heavy-duty/cast/archive/refs/heads/dev-branch.tar.gz",
    );
    expect(stdout).toContain("installing cast (heavy-duty/cast@dev-branch)");
    expect(
      readFileSync(join(sb.dest, "versions/0.5.0/INSTALLED_FROM"), "utf8"),
    ).toBe("heavy-duty/cast@dev-branch\n");
  });
});

describe("the shared gates cannot drift", () => {
  // install.sh and bin/cast each carry valid_version and pkg_version — the
  // same trust boundary enforced in two places. A byte-identical diff is the
  // rig-precedent guard that an edit to one cannot quietly miss the other.
  function extractFunction(file: string, name: string): string {
    const text = readFileSync(file, "utf8");
    const start = text.indexOf(`${name}() {`);
    expect(start, `${name}() not found in ${file}`).toBeGreaterThan(-1);
    const end = text.indexOf("\n}", start);
    return text.slice(start, end + 2);
  }

  for (const fn of ["valid_version", "pkg_version"]) {
    it(`${fn}() is byte-identical between install.sh and bin/cast`, () => {
      expect(extractFunction(INSTALL_SH, fn)).toBe(
        extractFunction(REAL_BIN_CAST, fn),
      );
    });
  }
});
