/**
 * P-1.1 · PluginManifest 契约（canonical 方言——GM 裁定 plugin.md §3.1 为唯一权威）。
 *
 * 规格来源（逐项对照 `.artifacts/gm-report-20260922/plugin.md` §3.1 L73-110）：
 * - 身份 L78-82：pluginKey（复用 integrationProjectKeySchema 规则）/ pluginVersion（semver）/
 *   pluginKind（PACK|ADAPTER|CAPABILITY|WORKFLOW|FRONTEND_MODULE）/ publisherRef；
 * - 兼容 L84-86：hostApiRange（semver range，必填、装载前强制求解）/ schemaVersion（清单自身版本）；
 * - 依赖 L88-91：requires（缺一不装）/ conflicts / provides（capabilityRef）；
 * - 权限 L93-99：readScopes / writeScopes（非空 ⇒ 必须走 CONTROLLED_WRITE 授权门）/
 *   authRequirements / sideEffects / riskClass / simulationOnly（与宿主门禁求交、不能放宽）；
 *   默认拒绝；
 * - 生命周期 L101-104：hooks（onLoad/onEnable/onDisable/onUpgrade/onUninstall）/
 *   healthCheck / readinessCheck / rollbackPlan（宿主调用）；
 * - 入口 L102：entryPoint（host 动态加载的唯一入口）；
 * - 证据 L109：evidenceRequirements / localizationRefs / frontendModuleRegistry
 *   （原文列于自由扩展区——兼容边界待定，故为 optional）。
 *
 * 方言裁决：shared 侧 B3 §D1 并行方言已 legacy 化让出 canonical 名
 * （`.artifacts/impl/20260927-dialect-convergence.md`）；本包从 v1 起。
 *
 * 零方言（与 agent-workforce-contract 先例一致，直接复用 @neuroclaw/shared）：
 * - pluginKey 复用 `integrationProjectKeySchema`（snake_case 唯一键）；
 * - hostApiRange / versionRange 复用 `semverRangeSchema`（S1 fail-closed 门）；
 * - provides 的 capabilityRef 复用 `universalIdSchema`。
 *
 * 边界：纯契约（无 IO / 无副作用 / 零接线）。装载前 range 求值属 P1-2；宿主强制门禁属 P-2。
 * 指纹：契约冻结批无数据文件（同 AW-0 先例），本批不提供清单指纹函数。
 */
import { valid } from "semver";
import { z } from "zod";
import {
  integrationProjectKeySchema,
  semverRangeSchema,
  universalIdSchema
} from "@neuroclaw/shared";

/** 清单自身版本（独立于 pluginVersion；plugin.md §3.1 L86）。 */
export const PLUGIN_MANIFEST_SCHEMA_VERSION = "plugin.manifest.v1";

// ---------------------------------------------------------------------------
// §1 身份（稳定核心，冻结；plugin.md §3.1 L78-82）
// ---------------------------------------------------------------------------

/** pluginKey：snake_case 唯一键——直接复用 shared `integrationProjectKeySchema`（零方言）。 */
export const pluginKeySchema = integrationProjectKeySchema;
export type PluginKey = z.infer<typeof pluginKeySchema>;

/**
 * pluginVersion：严格 semver 版本号（range 语义仅见于 hostApiRange/versionRange，
 * 版本号本身不承载范围）。校验经 `semver.valid`，非法即拒（fail-closed）。
 */
export const semverVersionSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    if (valid(value) === null) {
      ctx.addIssue({
        code: "custom",
        message: `Invalid semver version: ${JSON.stringify(value)}`
      });
    }
  });

/** pluginKind：五类插件形态（L81）。 */
export const pluginKindSchema = z.enum([
  "PACK",
  "ADAPTER",
  "CAPABILITY",
  "WORKFLOW",
  "FRONTEND_MODULE"
]);
export type PluginKind = z.infer<typeof pluginKindSchema>;

/** publisherRef：发布方身份（用于来源校验/签名；L82）。 */
export const publisherRefSchema = z.string().min(1);

// ---------------------------------------------------------------------------
// §2 兼容（稳定核心，冻结；L84-86）
// ---------------------------------------------------------------------------

/** schemaVersion：清单自身版本——本批仅接受当前 version（literal，可随版本演进）。 */
export const manifestSchemaVersionSchema = z.literal(PLUGIN_MANIFEST_SCHEMA_VERSION);

// ---------------------------------------------------------------------------
// §3 依赖（稳定核心，冻结；L88-91）
// ---------------------------------------------------------------------------

/** 依赖/冲突条目 `{pluginKey, versionRange}`：requires 缺一不装（L89）。 */
export const pluginRequirementSchema = z
  .object({
    pluginKey: integrationProjectKeySchema,
    versionRange: semverRangeSchema
  })
  .strict();
export type PluginRequirement = z.infer<typeof pluginRequirementSchema>;

// ---------------------------------------------------------------------------
// §4 权限（稳定核心，冻结；默认拒绝；L93-99）
// ---------------------------------------------------------------------------

/** 风险档（L98）。 */
export const pluginRiskClassSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type PluginRiskClass = z.infer<typeof pluginRiskClassSchema>;

// ---------------------------------------------------------------------------
// §5 生命周期与入口（稳定核心，冻结；宿主调用；L101-104）
// ---------------------------------------------------------------------------

/** 模块引用：相对路径 / 包名 / 模块内导出符号（entryPoint 与各钩子/检查点共用）。 */
export const pluginModuleRefSchema = z.string().min(1);

/** hooks：五枚生命周期钩子（全可缺省；L103）。 */
export const pluginHooksSchema = z
  .object({
    onLoad: pluginModuleRefSchema.optional(),
    onEnable: pluginModuleRefSchema.optional(),
    onDisable: pluginModuleRefSchema.optional(),
    onUpgrade: pluginModuleRefSchema.optional(),
    onUninstall: pluginModuleRefSchema.optional()
  })
  .strict();
export type PluginHooks = z.infer<typeof pluginHooksSchema>;

// ---------------------------------------------------------------------------
// §6 PluginManifest 总 schema（七组；.strict()：未知字段一律拒收）
// ---------------------------------------------------------------------------

/**
 * PluginManifest：可执行单元的身份证（plugin.md §3.1 L75 分层）。
 * - hostApiRange 必填：装载前强制求解（P1-2）；
 * - 权限组默认拒绝：不声明（或空数组）= 无对应权限；
 * - riskClass / simulationOnly 无默认、必须显式（安全字段不得隐式放宽）；
 * - writeScopes 非空 ⇒ 执行侧必须走 CONTROLLED_WRITE 授权门（运行期语义，属 P-2）。
 */
export const pluginManifestSchema = z
  .object({
    // §1 身份（L78-82）
    pluginKey: integrationProjectKeySchema,
    pluginVersion: semverVersionSchema,
    pluginKind: pluginKindSchema,
    publisherRef: publisherRefSchema,
    // §2 兼容（L84-86）
    hostApiRange: semverRangeSchema,
    schemaVersion: manifestSchemaVersionSchema,
    // §3 依赖（L88-91）
    requires: z.array(pluginRequirementSchema).default([]),
    conflicts: z.array(pluginRequirementSchema).default([]),
    provides: z.array(universalIdSchema).default([]),
    // §4 权限（L93-99；默认拒绝）
    readScopes: z.array(z.string().min(1)).default([]),
    writeScopes: z.array(z.string().min(1)).default([]),
    authRequirements: z.array(z.string().min(1)).default([]),
    sideEffects: z.array(z.string().min(1)).default([]),
    riskClass: pluginRiskClassSchema,
    simulationOnly: z.boolean(),
    // §5 生命周期（L101-104；宿主调用；可缺省）
    hooks: pluginHooksSchema.optional(),
    healthCheck: pluginModuleRefSchema.optional(),
    readinessCheck: pluginModuleRefSchema.optional(),
    rollbackPlan: pluginModuleRefSchema.optional(),
    // §6 入口（L102；host 动态加载唯一入口；必填）
    entryPoint: pluginModuleRefSchema,
    // §7 证据（L109；原文列于自由扩展区——兼容边界待定，可缺省）
    evidenceRequirements: z.array(z.string().min(1)).optional(),
    localizationRefs: z.array(z.string().min(1)).optional(),
    frontendModuleRegistry: z.array(z.string().min(1)).optional()
  })
  .strict();
export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** 解析插件清单：fail-closed（失败抛 ZodError）；成功返回已填充默认键位的对象。 */
export function parsePluginManifest(input: unknown): PluginManifest {
  return pluginManifestSchema.parse(input);
}
