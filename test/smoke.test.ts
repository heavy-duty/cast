import { describe, expect, it, vi } from "vitest";
import { CoolifyClient } from "../src/coolify.js";
import { smoke } from "../src/smoke.js";

type EnvVar = {
  key: string;
  value: string;
  is_buildtime: boolean;
  uuid: string;
};

// A stateful fetch mock standing in for Coolify's env-var store, so the
// bulk-write step's effect on previously-written keys is observable —
// `bulkMode: "upsert"` mirrors verified Coolify 4.1.2 behavior (see
// syncEnv's comment in cli.ts); `bulkMode: "replace"` simulates a
// regression to full-replace that smoke must catch.
function mockEnvStore(
  appUuid: string,
  bulkMode: "upsert" | "replace",
): typeof fetch {
  let store: EnvVar[] = [];
  let nextUuid = 1;
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = new URL(String(url)).pathname;
    const base = `/api/v1/applications/${appUuid}/envs`;
    if (method === "GET" && path === base) {
      return new Response(JSON.stringify(store), { status: 200 });
    }
    if (method === "POST" && path === base) {
      const body = JSON.parse(String(init?.body)) as {
        key: string;
        value: string;
        is_buildtime: boolean;
      };
      const created: EnvVar = { ...body, uuid: `env-${nextUuid++}` };
      store.push(created);
      return new Response(JSON.stringify(created), { status: 200 });
    }
    if (method === "PATCH" && path === `${base}/bulk`) {
      const body = JSON.parse(String(init?.body)) as {
        data: Array<{ key: string; value: string; is_buildtime: boolean }>;
      };
      if (bulkMode === "replace") {
        store = body.data.map((v) => ({ ...v, uuid: `env-${nextUuid++}` }));
      } else {
        for (const v of body.data) {
          const existing = store.find((e) => e.key === v.key);
          if (existing) Object.assign(existing, v);
          else store.push({ ...v, uuid: `env-${nextUuid++}` });
        }
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (method === "DELETE" && path.startsWith(`${base}/`)) {
      const uuid = path.slice(`${base}/`.length);
      store = store.filter((e) => e.uuid !== uuid);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && path === "/api/v1/version") {
      return new Response("4.1.2", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("smoke", () => {
  it("passes and leaves no residue when bulk env write is a true upsert", async () => {
    const fetchImpl = mockEnvStore("app-1", "upsert");
    const client = new CoolifyClient("https://coolify.test", "tok", fetchImpl);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(smoke(client, "app-1")).resolves.toBeUndefined();
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/smoke OK/);
    log.mockRestore();
    // both probe vars cleaned up
    const envsRes = await fetchImpl(
      "https://coolify.test/api/v1/applications/app-1/envs",
      { method: "GET" },
    );
    expect(await envsRes.json()).toEqual([]);
  });

  it("fails loudly when the bulk env write is destructive (full-replace regression)", async () => {
    const fetchImpl = mockEnvStore("app-1", "replace");
    const client = new CoolifyClient("https://coolify.test", "tok", fetchImpl);
    await expect(smoke(client, "app-1")).rejects.toThrow(
      /bulk env write is destructive \(full-replace\) — never-delete broken/,
    );
  });
});
