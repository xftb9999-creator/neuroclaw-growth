import { valid } from "semver";
import { z } from "zod";

import { assertSemverRange, semverRangeSchema } from "./semver-range.js";

/**
 * @deprecated Legacy B3 §D1 dialect — retired 2026-09-27 (GM ruling, Option A).
 * The sole authoritative PluginManifest dialect is `plugin.md §3.1` (L73-110:
 * identity/compatibility/dependency/permission/lifecycle/entry/evidence). The
 * canonical `pluginManifestSchema` / `PluginManifest` names belong to the new
 * `@neuroclaw/plugin-contract` package (P1-1); this module is kept for history
 * only — no new imports, pending deletion with the new package.
 * Evidence: `.artifacts/impl/20260927-dialect-convergence.md`.
 *
 * --- Historical module docs (legacy dialect) ---
 *
 * P-1 / D1: PluginManifest schema (B3 §D1 — "no self-built ABI").
 *
 * The manifest is a projection layer onto existing ecosystem formats, not a
 * new protocol: `version` is SemVer 2.0.0, the `skill` block mirrors Agent
 * Skills frontmatter + progressive disclosure, and `mcp.declares` mirrors
 * MCP tool/resource/prompt primitives. Everything else (`schemaVersion`,
 * `kind`, `capabilities`, `requires`, `permissions`, `sandbox`, `evidence`)
 * is project-specific metadata.
 *
 * The D1.4 hard constraints are encoded in the schema itself (fail-closed,
 * not documentation):
 * 1. Every `capabilities.provides` entry must be redeemable — either an
 *    `mcp.declares.tools[].name`, or (for `kind: skill | pack`) registered in
 *    the manifest's `capabilityRefs` (the C9 ProjectPackManifest mapping).
 * 2. `permissions.sideEffects ≠ ["none"]` forces `sandbox.isolation ≠
 *    in-process` — the plugin-side extension of the simulationOnly fail-closed
 *    gate.
 *
 * S1 applies here too: `version`, `requires.hostApi` and every
 * `requires.plugins` range are parsed by real semver at parse time; anything
 * unparseable rejects the manifest.
 */

/**
 * @deprecated Legacy dialect constant — superseded by the §3.1
 * `@neuroclaw/plugin-contract` package (P1-1); renamed to vacate the
 * canonical `PLUGIN_SCHEMA_VERSION` name.
 */
export const LEGACY_PLUGIN_SCHEMA_VERSION = "plugin.neuroclaw.v1";

/** npm-scope-style identity, per D1.2 (`@namespace/name`). */
const pluginIdSchema = z
  .string()
  .regex(
    /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/,
    "plugin id must look like @namespace/name (npm scope convention)"
  );

const semverVersionSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    if (valid(value) === null) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid SemVer 2.0.0 version: ${JSON.stringify(value)}`
      });
    }
  });

const mcpDeclaresSchema = z
  .object({
    tools: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().min(1),
            inputSchema: z.record(z.string(), z.unknown())
          })
          .strict()
      )
      .default([]),
    resources: z
      .array(
        z
          .object({
            uri: z.string().min(1),
            name: z.string().min(1),
            mimeType: z.string().min(1)
          })
          .strict()
      )
      .default([]),
    prompts: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().min(1)
          })
          .strict()
      )
      .default([])
  })
  .strict();

/**
 * @deprecated Legacy B3 §D1 manifest schema — retired; use the §3.1 dialect from
 * `@neuroclaw/plugin-contract` (P1-1). Renamed to vacate the `pluginManifestSchema`
 * name for the canonical package.
 */
export const legacyPluginManifestSchema = z
  .object({
    schemaVersion: z.literal(LEGACY_PLUGIN_SCHEMA_VERSION),
    id: pluginIdSchema,
    version: semverVersionSchema,
    kind: z.enum(["skill", "mcp-server", "adapter", "pack"]),
    skill: z
      .object({
        skillMd: z.string().min(1),
        name: z.string().min(1),
        description: z.string().min(1),
        // Three-stage progressive disclosure (A2 §2.1 / agentskills.io).
        disclosure: z
          .object({
            level1: z.literal("frontmatter"),
            level2: z.literal("body"),
            level3: z.literal("references")
          })
          .strict()
      })
      .strict()
      .optional(),
    mcp: z
      .object({
        transport: z.enum(["stdio", "sse", "http"]),
        command: z.string().min(1).optional(),
        args: z.array(z.string()).optional(),
        url: z.string().min(1).optional(),
        declares: mcpDeclaresSchema.optional()
      })
      .strict()
      .optional(),
    capabilities: z
      .object({
        layer: z.enum(["L0", "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8"]),
        provides: z.array(z.string().min(1))
      })
      .strict(),
    // C9 mapping target: ProjectPackManifest.capabilityRefs for kind skill/pack.
    capabilityRefs: z.array(z.string().min(1)).optional(),
    requires: z
      .object({
        plugins: z.record(z.string(), semverRangeSchema).default({}),
        hostApi: semverRangeSchema
      })
      .strict(),
    permissions: z
      .object({
        scopes: z
          .object({
            read: z.array(z.string()),
            write: z.array(z.string())
          })
          .strict(),
        sideEffects: z
          .array(z.enum(["none", "network", "filesystem", "external-write"]))
          .min(1),
        // Credential *reference names* only — never values (B3 D4).
        credentials: z.array(z.string()),
        quota: z
          .object({
            maxInvocationsPerRun: z.number().int().nonnegative(),
            maxWallClockMs: z.number().int().positive(),
            maxNetworkBytes: z.number().int().nonnegative()
          })
          .strict()
      })
      .strict(),
    sandbox: z
      .object({
        isolation: z.enum(["in-process", "subprocess", "container"]),
        network: z
          .object({
            mode: z.enum(["none", "allowlist"]),
            allow: z.array(z.string()).default([])
          })
          .strict(),
        env: z.object({ allow: z.array(z.string()) }).strict()
      })
      .strict(),
    evidence: z
      .object({
        level: z.enum(["E0", "E1", "E2", "E3"]),
        refs: z.array(z.string())
      })
      .strict()
  })
  .strict()
  .superRefine((manifest, ctx) => {
    // D1.4-1: capabilities must be redeemable.
    const toolNames = new Set(
      (manifest.mcp?.declares?.tools ?? []).map((tool) => tool.name)
    );
    const registeredRefs = new Set(manifest.capabilityRefs ?? []);
    for (const provide of manifest.capabilities.provides) {
      const redeemable =
        toolNames.has(provide) ||
        ((manifest.kind === "skill" || manifest.kind === "pack") &&
          registeredRefs.has(provide));
      if (!redeemable) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilities", "provides"],
          message:
            `Capability ${JSON.stringify(provide)} is not redeemable: it must match an ` +
            `mcp.declares.tools name, or be registered in capabilityRefs for kind skill/pack`
        });
      }
    }

    // Structural honesty: a declared load kind must ship its carrier block.
    if (manifest.kind === "mcp-server" && !manifest.mcp) {
      ctx.addIssue({
        code: "custom",
        path: ["mcp"],
        message: "kind mcp-server requires the mcp block"
      });
    }
    if (manifest.kind === "skill" && !manifest.skill) {
      ctx.addIssue({
        code: "custom",
        path: ["skill"],
        message: "kind skill requires the skill block"
      });
    }

    // D1.4-2: side-effecting plugins may not run in-process (fail-closed).
    const sideEffectFree =
      manifest.permissions.sideEffects.length === 1 &&
      manifest.permissions.sideEffects[0] === "none";
    if (!sideEffectFree && manifest.sandbox.isolation === "in-process") {
      ctx.addIssue({
        code: "custom",
        path: ["sandbox", "isolation"],
        message:
          "plugins with side effects must declare sandbox.isolation other than in-process"
      });
    }
  });

/**
 * @deprecated Legacy type — see `legacyPluginManifestSchema`; use the §3.1
 * `PluginManifest` from `@neuroclaw/plugin-contract`.
 */
export type LegacyPluginManifest = z.infer<typeof legacyPluginManifestSchema>;

/**
 * Parse and validate a legacy PluginManifest payload. Exported so fail-closed
 * cases are testable.
 * @deprecated Use the §3.1 parser from `@neuroclaw/plugin-contract` (P1-1).
 */
export function parseLegacyPluginManifest(raw: unknown): LegacyPluginManifest {
  return legacyPluginManifestSchema.parse(raw);
}

// Keep assertSemverRange referenced in this module's public surface docs so
// the S1 gate is greppable next to the manifest it guards.
export { assertSemverRange };
