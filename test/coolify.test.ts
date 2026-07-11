import { describe, expect, it, vi } from "vitest";
import { CoolifyClient } from "../src/coolify.js";

function mockFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${new URL(String(url)).pathname}`;
    if (!(key in routes)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("CoolifyClient", () => {
  it("sends bearer auth and resolves servers by name", async () => {
    const fetchImpl = mockFetch({
      "GET /api/v1/servers": [{ uuid: "srv-1", name: "prod-box" }],
    });
    const c = new CoolifyClient("https://coolify.test", "tok", fetchImpl);
    expect(await c.serverUuid("prod-box")).toBe("srv-1");
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect((call[1].headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
  });
  it("throws a named error when a resolver misses", async () => {
    const c = new CoolifyClient(
      "https://coolify.test",
      "tok",
      mockFetch({ "GET /api/v1/servers": [] }),
    );
    await expect(c.serverUuid("nope")).rejects.toThrow(
      /not found in Coolify: server nope/,
    );
  });
  it("surfaces API errors with method, path and status", async () => {
    const c = new CoolifyClient("https://coolify.test", "tok", mockFetch({}));
    await expect(c.get("/projects")).rejects.toThrow(/GET \/projects → 404/);
  });
  it("reads version as plain text, not JSON", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("4.1.2", { status: 200 }),
    ) as unknown as typeof fetch;
    const c = new CoolifyClient("https://coolify.test", "tok", fetchImpl);
    await expect(c.version()).resolves.toBe("4.1.2");
  });
});
