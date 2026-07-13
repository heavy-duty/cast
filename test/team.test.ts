import { describe, expect, it, vi } from "vitest";
import { CoolifyClient } from "../src/coolify.js";
import { assertTeam } from "../src/team.js";

function clientReturning(team: unknown, status = 200): CoolifyClient {
  const fetchImpl = vi.fn(
    async () => new Response(JSON.stringify(team), { status }),
  ) as unknown as typeof fetch;
  return new CoolifyClient("https://coolify.test", "tok", fetchImpl);
}

const HEAVY_DUTY = { id: 1, name: "heavy-duty", personal_team: false };

describe("assertTeam", () => {
  it("passes when both id and name match, returning the live team", async () => {
    const team = await assertTeam(
      clientReturning(HEAVY_DUTY),
      { id: 1, name: "heavy-duty" },
      "prod",
    );
    expect(team).toEqual({ id: 1, name: "heavy-duty" });
  });

  it("passes on id alone, and on name alone", async () => {
    await expect(
      assertTeam(clientReturning(HEAVY_DUTY), { id: 1 }, "prod"),
    ).resolves.toBeTruthy();
    await expect(
      assertTeam(clientReturning(HEAVY_DUTY), { name: "heavy-duty" }, "prod"),
    ).resolves.toBeTruthy();
  });

  // The whole point of the issue: a token minted under another team must turn
  // a silent mis-target into a refusal, because Coolify itself would not
  // error — it would resolve every resource to null and invite a duplicate
  // create in the wrong team.
  it("refuses on an id mismatch, naming both teams and the environment", async () => {
    const err = await assertTeam(
      clientReturning({ id: 3, name: "personal" }),
      { id: 1, name: "heavy-duty" },
      "prod",
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/wrong team/);
    expect((err as Error).message).toMatch(/environment:\s+prod/);
    expect((err as Error).message).toMatch(/expected team:\s+id=1/);
    expect((err as Error).message).toMatch(/token's team:\s+id=3/);
    expect((err as Error).message).toMatch(/mismatched:\s+id, name/);
  });

  // A renamed-but-same-id team, or an id typo against a right-named team:
  // either half mismatching is a refusal. Both are compared when both given.
  it("refuses when only the name mismatches", async () => {
    await expect(
      assertTeam(
        clientReturning({ id: 1, name: "some-other-team" }),
        { id: 1, name: "heavy-duty" },
        "prod",
      ),
    ).rejects.toThrow(/mismatched:\s+name/);
  });

  it("refuses when only the id mismatches", async () => {
    await expect(
      assertTeam(
        clientReturning({ id: 9, name: "heavy-duty" }),
        { id: 1, name: "heavy-duty" },
        "prod",
      ),
    ).rejects.toThrow(/mismatched:\s+id/);
  });

  // An unreadable answer is not "no team" — it is an unknown answer to the one
  // question we must not guess at, so it fails rather than degrading to a pass.
  it("refuses when /teams/current has no usable identity", async () => {
    await expect(
      assertTeam(
        clientReturning({ message: "Unauthenticated." }),
        { id: 1 },
        "prod",
      ),
    ).rejects.toThrow(/no usable team identity/);
  });

  it("surfaces a token rejection rather than swallowing it", async () => {
    await expect(
      assertTeam(
        clientReturning({ message: "bad token" }, 401),
        { id: 1 },
        "prod",
      ),
    ).rejects.toThrow(/GET \/teams\/current → 401/);
  });

  // Team 0 is the Root Team — the team the first user of an instance gets
  // (app/Models/User.php @ v4.1.2). On a single-admin Coolify it is the team
  // everything lives in, so `0` must be a first-class expectation, not a
  // falsy value that quietly compares as absent.
  it("compares team id 0 (the Root Team) as a real expectation", async () => {
    const root = { id: 0, name: "Root Team" };
    await expect(
      assertTeam(clientReturning(root), { id: 0 }, "prod"),
    ).resolves.toEqual(root);
    await expect(
      assertTeam(
        clientReturning({ id: 3, name: "personal" }),
        { id: 0 },
        "prod",
      ),
    ).rejects.toThrow(/wrong team/);
  });

  // The gate must fail closed on its own, without leaning on the bindings
  // schema to have rejected an empty team first: an expectation that names
  // nothing would compare nothing and pass against ANY team.
  it("refuses an expectation that names neither id nor name", async () => {
    await expect(
      assertTeam(clientReturning({ id: 99, name: "anything" }), {}, "prod"),
    ).rejects.toThrow(/names neither an id nor a name/);
  });
});
