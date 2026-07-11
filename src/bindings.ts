import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

const BindingsSchema = z
  .object({
    environments: z.record(
      z
        .object({
          server: z.string(),
          s3_destination: z.string().optional(),
          // Var-name patterns this environment refuses outright (see
          // assertEnvVarPolicy). Operator-owned guard: prod typically bans
          // whatever family of flags enables destructive tooling.
          forbidden_var_patterns: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    github_apps: z.record(z.string()),
    smoke_target: z.string().optional(),
  })
  .strict();

export type Bindings = z.infer<typeof BindingsSchema>;

export function loadBindings(path: string): Bindings {
  const result = BindingsSchema.safeParse(parse(readFileSync(path, "utf8")));
  if (!result.success) {
    throw new Error(`invalid bindings ${path}: ${result.error.message}`);
  }
  return result.data;
}
