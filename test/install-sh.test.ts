import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);

// These tests run the REAL install.sh — not a reimplementation of its
// logic — with curl and npm replaced by PATH shims, so every channel
// (latest asset, pinned asset, build-from-source) is exercised offline.
// The shims record what was requested; the assertions read the wire log
// and the resulting tree, the same way rig's cli.sh proves its installer.

const INSTALL_SH = join(process.cwd(), "install.sh");

// curl shim: answers from CAST_TEST_* env vars, appends every URL to
// CAST_TEST_CURL_LOG. Exit 22 is curl's own "-f saw an HTTP error".
const CURL_SHIM = `#!/usr/bin/env bash
set -euo pipefail
out=""; url=""
args=("$@")
i=0
while [ $i -lt \${#args[@]} ]; do
  a="\${args[$i]}"
  case "$a" in
    -o) i=$((i+1)); out="\${args[$i]}" ;;
    -w) i=$((i+1)) ;;
    http*) url="$a" ;;
  esac
  i=$((i+1))
done
printf '%s\\n' "$url" >> "$CAST_TEST_CURL_LOG"
case "$url" in
  */releases/latest)
    [ -n "\${CAST_TEST_LATEST:-}" ] || exit 22
    printf '%s' "$CAST_TEST_LATEST"
    ;;
  */releases/download/*)
    if [ -n "\${CAST_TEST_ASSET_FILE:-}" ] && [ "$url" = "\${CAST_TEST_ASSET_URL:-}" ]; then
      cp "$CAST_TEST_ASSET_FILE" "$out"
    else
      exit 22
    fi
    ;;
  */archive/refs/tags/*)
    if [ -n "\${CAST_TEST_TAGS_TARBALL:-}" ]; then cp "$CAST_TEST_TAGS_TARBALL" "$out"; else exit 22; fi
    ;;
  */archive/refs/heads/*)
    if [ -n "\${CAST_TEST_HEADS_TARBALL:-}" ]; then cp "$CAST_TEST_HEADS_TARBALL" "$out"; else exit 22; fi
    ;;
  *) exit 22 ;;
esac
`;

// npm shim: logs every invocation; 'run build' produces dist/cli.js so a
// source install ends up runnable. The prebuilt channels get a POISONED
// npm instead — if the installer touches npm at all on an asset install,
// the install fails and so does the test.
const NPM_SHIM = `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$CAST_TEST_NPM_LOG"
case "\${1:-}" in
  ci) exit 0 ;;
  run) mkdir -p dist && printf '// built by npm shim\\n' > dist/cli.js ;;
  prune) exit 0 ;;
esac
`;

const POISONED_NPM = `#!/usr/bin/env bash
printf 'npm %s\\n' "$*" >> "$CAST_TEST_NPM_LOG"
exit 97
`;

type Sandbox = {
  root: string;
  stubs: string;
  dest: string;
  bindir: string;
  curlLog: string;
  npmLog: string;
  env: Record<string, string>;
};

function sandbox(opts: { poisonNpm: boolean }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "cast-install-"));
  const stubs = join(root, "stubs");
  const home = join(root, "home");
  const dest = join(root, "cast-home");
  const bindir = join(root, "bin");
  mkdirSync(stubs);
  mkdirSync(home);
  const curlLog = join(root, "curl.log");
  const npmLog = join(root, "npm.log");
  writeFileSync(curlLog, "");
  writeFileSync(npmLog, "");
  writeFileSync(join(stubs, "curl"), CURL_SHIM);
  writeFileSync(join(stubs, "npm"), opts.poisonNpm ? POISONED_NPM : NPM_SHIM);
  chmodSync(join(stubs, "curl"), 0o755);
  chmodSync(join(stubs, "npm"), 0o755);
  return {
    root,
    stubs,
    dest,
    bindir,
    curlLog,
    npmLog,
    env: {
      PATH: `${stubs}:${process.env.PATH}`,
      HOME: home,
      SHELL: "/bin/bash",
      CAST_HOME: dest,
      CAST_BIN: bindir,
      CAST_NO_MODIFY_PATH: "1",
      CAST_TEST_CURL_LOG: curlLog,
      CAST_TEST_NPM_LOG: npmLog,
    },
  };
}

// Build a .tgz fixture with a single top-level dir, like both real shapes.
async function makeTarball(
  root: string,
  topdir: string,
  files: Record<string, string>,
): Promise<string> {
  const stage = join(root, "fixtures", topdir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(stage, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  const tgz = join(root, "fixtures", `${topdir}.tgz`);
  await run("tar", ["-C", join(root, "fixtures"), "-czf", tgz, topdir]);
  return tgz;
}

const PREBUILT_FILES = {
  "bin/cast": "#!/usr/bin/env bash\necho fake-cast\n",
  "dist/cli.js": "// prebuilt in CI\n",
  "node_modules/yaml/package.json": "{}",
  "package.json": '{ "name": "cast", "version": "0.2.0" }\n',
};

const SOURCE_FILES = {
  "bin/cast": "#!/usr/bin/env bash\necho fake-cast\n",
  "package.json": '{ "name": "cast", "version": "0.3.0-dev" }\n',
  "src/cli.ts": "// source only — dist/ does not exist until npm run build\n",
};

async function runInstaller(sb: Sandbox, extraEnv: Record<string, string>) {
  return run("bash", [INSTALL_SH], {
    env: { ...sb.env, ...extraEnv },
  });
}

describe("install.sh — default channel (latest release asset)", () => {
  it("resolves the latest tag via the redirect and installs the prebuilt tree without npm", async () => {
    const sb = sandbox({ poisonNpm: true });
    const asset = await makeTarball(sb.root, "cast-0.2.0", PREBUILT_FILES);
    const { stdout } = await runInstaller(sb, {
      CAST_TEST_LATEST: "https://github.com/heavy-duty/cast/releases/tag/0.2.0",
      CAST_TEST_ASSET_URL:
        "https://github.com/heavy-duty/cast/releases/download/0.2.0/cast-0.2.0.tgz",
      CAST_TEST_ASSET_FILE: asset,
    });

    expect(stdout).toContain(
      "installing cast 0.2.0 (latest release of heavy-duty/cast)",
    );
    // The tree landed, prebuilt: dist/ came from the tarball, not a build.
    expect(readFileSync(join(sb.dest, "dist/cli.js"), "utf8")).toContain(
      "prebuilt in CI",
    );
    expect(existsSync(join(sb.dest, "node_modules/yaml/package.json"))).toBe(
      true,
    );
    expect(readlinkSync(join(sb.bindir, "cast"))).toBe(
      join(sb.dest, "bin/cast"),
    );
    // npm is poisoned — a single invocation would have failed the install.
    expect(readFileSync(sb.npmLog, "utf8")).toBe("");
  });

  it("dies loudly when there is no release to resolve, pointing at CAST_REF=main", async () => {
    const sb = sandbox({ poisonNpm: true });
    await expect(runInstaller(sb, {})).rejects.toMatchObject({
      stderr: expect.stringContaining("CAST_REF=main installs from source"),
    });
    expect(existsSync(sb.dest)).toBe(false);
  });

  it("dies when the redirect lands somewhere that is not a tag page", async () => {
    const sb = sandbox({ poisonNpm: true });
    await expect(
      runInstaller(sb, {
        CAST_TEST_LATEST: "https://github.com/heavy-duty/cast/releases",
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("could not resolve the latest release"),
    });
  });
});

describe("install.sh — pinned channel (CAST_REF=X.Y.Z)", () => {
  it("uses that tag's release asset and never falls through to a source build", async () => {
    const sb = sandbox({ poisonNpm: true });
    const asset = await makeTarball(sb.root, "cast-0.1.0", {
      ...PREBUILT_FILES,
      "package.json": '{ "name": "cast", "version": "0.1.0" }\n',
    });
    const { stdout } = await runInstaller(sb, {
      CAST_REF: "0.1.0",
      CAST_TEST_ASSET_URL:
        "https://github.com/heavy-duty/cast/releases/download/0.1.0/cast-0.1.0.tgz",
      CAST_TEST_ASSET_FILE: asset,
    });

    expect(stdout).toContain("installing cast 0.1.0 (pinned release asset)");
    const urls = readFileSync(sb.curlLog, "utf8");
    // No latest-resolution, no archive fallbacks — the pin answered.
    expect(urls).not.toContain("/releases/latest");
    expect(urls).not.toContain("/archive/refs/");
    expect(readFileSync(sb.npmLog, "utf8")).toBe("");
  });

  it("refuses a prebuilt asset that is not a runnable tree, leaving the old install alone", async () => {
    const sb = sandbox({ poisonNpm: true });
    // An asset missing dist/ — a broken release.
    const asset = await makeTarball(sb.root, "cast-0.4.0", {
      "bin/cast": "#!/usr/bin/env bash\n",
      "package.json": "{}",
    });
    // A previous install that must survive the refused upgrade.
    mkdirSync(join(sb.dest, "bin"), { recursive: true });
    writeFileSync(join(sb.dest, "bin/cast"), "#!/usr/bin/env bash\necho old\n");

    await expect(
      runInstaller(sb, {
        CAST_REF: "0.4.0",
        CAST_TEST_ASSET_URL:
          "https://github.com/heavy-duty/cast/releases/download/0.4.0/cast-0.4.0.tgz",
        CAST_TEST_ASSET_FILE: asset,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("not a runnable tree"),
    });
    // The shape check fired BEFORE rm -rf $DEST — the old tree survives.
    expect(readFileSync(join(sb.dest, "bin/cast"), "utf8")).toContain(
      "echo old",
    );
  });
});

describe("install.sh — dev channel (CAST_REF=<branch>)", () => {
  it("falls back asset → refs/tags → refs/heads and builds from source", async () => {
    const sb = sandbox({ poisonNpm: false });
    const src = await makeTarball(sb.root, "cast-main", SOURCE_FILES);
    const { stdout } = await runInstaller(sb, {
      CAST_REF: "main",
      CAST_TEST_HEADS_TARBALL: src,
    });

    expect(stdout).toContain(
      "no release asset for 'main' — building from source",
    );
    const urls = readFileSync(sb.curlLog, "utf8").trim().split("\n");
    expect(urls).toEqual([
      "https://github.com/heavy-duty/cast/releases/download/main/cast-main.tgz",
      "https://github.com/heavy-duty/cast/archive/refs/tags/main.tar.gz",
      "https://github.com/heavy-duty/cast/archive/refs/heads/main.tar.gz",
    ]);
    // The build ran here — ci, build, prune — and produced the dist tree.
    const npm = readFileSync(sb.npmLog, "utf8");
    expect(npm).toContain("npm ci");
    expect(npm).toContain("npm run build");
    expect(npm).toContain("npm prune --omit=dev");
    expect(readFileSync(join(sb.dest, "dist/cli.js"), "utf8")).toContain(
      "built by npm shim",
    );
  });

  it("dies when the ref exists nowhere (asset, tags, heads all miss)", async () => {
    const sb = sandbox({ poisonNpm: true });
    await expect(
      runInstaller(sb, { CAST_REF: "no-such-ref" }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("no tag or branch named 'no-such-ref'"),
    });
  });
});
