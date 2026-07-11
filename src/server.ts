import { readFileSync } from "node:fs";
import type { CoolifyClient } from "./coolify.js";

export async function serverAdd(
  client: CoolifyClient,
  opts: {
    name: string;
    ip: string;
    keyFile: string;
    user?: string;
    port?: number;
  },
): Promise<void> {
  const key = (await client.post("/security/keys", {
    name: `${opts.name}-root`,
    private_key: readFileSync(opts.keyFile, "utf8"),
  })) as { uuid: string };
  await client.post("/servers", {
    name: opts.name,
    ip: opts.ip,
    port: opts.port ?? 22,
    user: opts.user ?? "root",
    private_key_uuid: key.uuid,
    instant_validate: true,
  });
  console.log(
    `server ${opts.name} registered (${opts.ip}); check validation in Coolify`,
  );
}
