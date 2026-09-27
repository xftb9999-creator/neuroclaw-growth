/**
 * P1-2 · 装载前 semver 强制求值（pre-load compatibility solver）。
 *
 * 目标（plugin-roadmap.md:286 / plugin.md L145-148）：把 hostApiRange /
 * compatibilityRange 从「从不求值」变为「装载前强制求值」；不兼容区间
 * fail-closed。本模块是纯函数求解器（零 IO、零副作用），在宿主装载链中
 * 的约定位置：
 *
 *     扫描 → 【本模块求值】 → 动态 import(entryPoint) → 注册
 *
 * P2-1 装载器在动态 import 之前必须调用本模块（单件门
 * {@link assertHostApiCompatible} 或集合门 {@link verifyPluginManifestSet}）；
 * 校验失败即拒绝装载、不进入 registry（plugin.md §5 门禁 1）。
 *
 * 与既有实现的边界（实核 2026-09-27）：
 * - `@neuroclaw/shared` 的 `versionPinMatches`（semver-range.ts:118）仅在
 *   `NEUROCLAW_VERSION_MODE=range` 时求值 compatibilityRange，默认 `strict`
 *   下不求值。安全不变量不得用环境开关表达——本模块的 compatibilityRange
 *   门 **无条件求值**，不受该开关影响。
 * - `plugin-manifest.ts` 的 `semverRangeSchema` 只门「可解析性」（S1）；
 *   本模块在其后追加「与宿主版本求交 / 与集合内活动版本求交」。
 *
 * 宿主 API 版本（hostApiVersion）由调用方显式传入；P-3 定义 host × plugin
 * 兼容矩阵前，本模块不内置任何版本常量（零协议新增）。集合检查只覆盖
 * 已扫描集合内的依赖闭包；跨集合/网络求解属 P-3。
 */
import { satisfies, valid, validRange } from "semver";

import {
  pluginManifestSchema,
  type PluginManifest,
  type PluginRequirement
} from "./plugin-manifest.js";

// ---------------------------------------------------------------------------
// §0 结果类型
// ---------------------------------------------------------------------------

/** 装载前求值的失败分类（CLI 退出原因与宿主拒绝原因均据此）。 */
export type CompatibilityFindingCode =
  | "MANIFEST_INVALID"
  | "HOST_API_VERSION_INVALID"
  | "HOST_API_RANGE_UNSATISFIED"
  | "COMPATIBILITY_RANGE_INVALID"
  | "COMPATIBILITY_UNSATISFIED"
  | "SIMULATION_WRITE_ESCALATION"
  | "DUPLICATE_PLUGIN_KEY"
  | "DEPENDENCY_CYCLE"
  | "MISSING_DEPENDENCY"
  | "DEPENDENCY_VERSION_UNSATISFIED"
  | "CONFLICT_PRESENT";

export interface CompatibilityFinding {
  code: CompatibilityFindingCode;
  message: string;
  pluginKey?: string;
  /** 单件检查可携带输入序号（CLI 用其回指文件路径）。 */
  detail?: Record<string, unknown>;
}

/** 装载前求值的 fail-closed 错误（单件门）。 */
export class PluginCompatibilityError extends Error {
  readonly code: CompatibilityFindingCode;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: CompatibilityFindingCode,
    message: string,
    detail: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "PluginCompatibilityError";
    this.code = code;
    this.detail = detail;
  }
}

/** Fail-closed 求值原语：非法输入一律 false，绝不 true。 */
function versionSatisfies(version: string, range: string): boolean {
  try {
    return satisfies(version, range);
  } catch {
    return false;
  }
}

/** 可解析性（与 S1 门语义一致：空串不是 range）。 */
function isParsableRange(range: string): boolean {
  return range.trim().length > 0 && validRange(range) !== null;
}

function formatIssues(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues.map((issue) => `${issue.path.map(String).join(".") || "<root>"}: ${issue.message}`).join("; ");
}

function byPluginKey(a: PluginManifest, b: PluginManifest): number {
  return a.pluginKey < b.pluginKey ? -1 : a.pluginKey > b.pluginKey ? 1 : 0;
}

function byRequirementKey(a: PluginRequirement, b: PluginRequirement): number {
  return a.pluginKey < b.pluginKey ? -1 : a.pluginKey > b.pluginKey ? 1 : 0;
}

// ---------------------------------------------------------------------------
// §1 单件门：hostApiRange（必填、装载前强制求值）
// ---------------------------------------------------------------------------

/** 非抛错求值：host API 版本是否落在清单声明的 hostApiRange 内。 */
export function evaluateHostApiCompatibility(
  hostApiVersion: string,
  hostApiRange: string
): boolean {
  return versionSatisfies(hostApiVersion, hostApiRange);
}

/**
 * 单件装载前门：校验清单形状（.strict()，含 hostApiRange 必填）并与宿主
 * API 版本求交。任何失败抛 {@link PluginCompatibilityError}（fail-closed）；
 * 通过则返回已填充默认键位的清单。调用方必须在动态 import(entryPoint)
 * 之前调用本函数。
 */
export function assertHostApiCompatible(input: unknown, hostApiVersion: string): PluginManifest {
  const parsed = pluginManifestSchema.safeParse(input);
  if (!parsed.success) {
    throw new PluginCompatibilityError(
      "MANIFEST_INVALID",
      `invalid plugin manifest: ${formatIssues(parsed.error.issues)}`
    );
  }
  const manifest = parsed.data;
  if (valid(hostApiVersion) === null) {
    throw new PluginCompatibilityError(
      "HOST_API_VERSION_INVALID",
      `invalid host API version: ${JSON.stringify(hostApiVersion)}`,
      { hostApiVersion }
    );
  }
  if (!evaluateHostApiCompatibility(hostApiVersion, manifest.hostApiRange)) {
    throw new PluginCompatibilityError(
      "HOST_API_RANGE_UNSATISFIED",
      `host API ${hostApiVersion} does not satisfy hostApiRange ${JSON.stringify(manifest.hostApiRange)}`,
      { hostApiVersion, hostApiRange: manifest.hostApiRange, pluginKey: manifest.pluginKey }
    );
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// §2 compatibilityRange 门（无条件求值，不受 NEUROCLAW_VERSION_MODE 影响）
// ---------------------------------------------------------------------------

/** 非抛错求值：版本是否落在 compatibilityRange 内（非法输入 false）。 */
export function evaluateCompatibilityRange(version: string, compatibilityRange: string): boolean {
  return isParsableRange(compatibilityRange) && versionSatisfies(version, compatibilityRange);
}

/**
 * 无条件门（C-7「compatibilityRange 必须真正求值」）：与
 * `versionPinMatches` 不同，本函数不读任何环境开关，任何调用都真实求值。
 * 失败抛 {@link PluginCompatibilityError}（fail-closed）。
 */
export function assertCompatibilityRange(
  version: string,
  compatibilityRange: string,
  subject = "component"
): void {
  if (!isParsableRange(compatibilityRange)) {
    throw new PluginCompatibilityError(
      "COMPATIBILITY_RANGE_INVALID",
      `invalid compatibilityRange on ${subject}: ${JSON.stringify(compatibilityRange)}`,
      { subject, compatibilityRange }
    );
  }
  if (!versionSatisfies(version, compatibilityRange)) {
    throw new PluginCompatibilityError(
      "COMPATIBILITY_UNSATISFIED",
      `${subject} version ${JSON.stringify(version)} does not satisfy compatibilityRange ${JSON.stringify(compatibilityRange)}`,
      { subject, version, compatibilityRange }
    );
  }
}

// ---------------------------------------------------------------------------
// §3 集合检查（纯函数、确定性输出顺序；供装载器扫描步与 CLI 复用）
// ---------------------------------------------------------------------------

/**
 * 权限越权门（静态近似 plugin.md §5 门禁 6 前两类）：simulationOnly 清单
 * 不得声明 writeScopes / sideEffects——模拟声明与写能力不可同时成立，
 * 装载前即拒（运行期调用边界强制属 P2-2；五类负向套件属 P2-4）。
 */
export function findSimulationWriteEscalations(
  manifests: readonly PluginManifest[]
): CompatibilityFinding[] {
  const findings: CompatibilityFinding[] = [];
  for (const manifest of [...manifests].sort(byPluginKey)) {
    if (!manifest.simulationOnly) continue;
    const violations: string[] = [];
    if (manifest.writeScopes.length > 0) {
      violations.push(`writeScopes=${JSON.stringify(manifest.writeScopes)}`);
    }
    if (manifest.sideEffects.length > 0) {
      violations.push(`sideEffects=${JSON.stringify(manifest.sideEffects)}`);
    }
    if (violations.length > 0) {
      findings.push({
        code: "SIMULATION_WRITE_ESCALATION",
        pluginKey: manifest.pluginKey,
        message:
          `simulationOnly manifest declares ${violations.join(" and ")}: ` +
          "permission escalation rejected at pre-load"
      });
    }
  }
  return findings;
}

/** 集合内 pluginKey 重复（多个版本）即拒。 */
export function findDuplicatePluginKeys(
  manifests: readonly PluginManifest[]
): CompatibilityFinding[] {
  const versionsByKey = new Map<string, string[]>();
  for (const manifest of manifests) {
    const versions = versionsByKey.get(manifest.pluginKey) ?? [];
    versions.push(manifest.pluginVersion);
    versionsByKey.set(manifest.pluginKey, versions);
  }
  const findings: CompatibilityFinding[] = [];
  for (const pluginKey of [...versionsByKey.keys()].sort()) {
    const versions = versionsByKey.get(pluginKey)!;
    if (versions.length > 1) {
      findings.push({
        code: "DUPLICATE_PLUGIN_KEY",
        pluginKey,
        message: `duplicate pluginKey ${pluginKey} declared by ${versions.length} manifests (${[...versions].sort().join(", ")})`
      });
    }
  }
  return findings;
}

/** requires 依赖环检测（DFS；输出顺序确定）。 */
export function findDependencyCycles(
  manifests: readonly PluginManifest[]
): CompatibilityFinding[] {
  const byKey = new Map(manifests.map((manifest) => [manifest.pluginKey, manifest]));
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const findings: CompatibilityFinding[] = [];

  const visit = (pluginKey: string): void => {
    const current = state.get(pluginKey) ?? 0;
    if (current === 1) {
      const start = stack.indexOf(pluginKey);
      const cycle = [...stack.slice(start), pluginKey];
      findings.push({
        code: "DEPENDENCY_CYCLE",
        pluginKey,
        message: `dependency cycle: ${cycle.join(" -> ")}`,
        detail: { cycle }
      });
      return;
    }
    if (current === 2) return;
    state.set(pluginKey, 1);
    stack.push(pluginKey);
    const manifest = byKey.get(pluginKey);
    if (manifest) {
      for (const requirement of [...manifest.requires].sort(byRequirementKey)) {
        if (byKey.has(requirement.pluginKey)) visit(requirement.pluginKey);
      }
    }
    stack.pop();
    state.set(pluginKey, 2);
  };

  for (const pluginKey of [...byKey.keys()].sort()) visit(pluginKey);
  return findings;
}

/** requires 闭包：缺失依赖 / 集合内版本不满足声明区间。 */
export function findUnresolvedDependencies(
  manifests: readonly PluginManifest[]
): CompatibilityFinding[] {
  const byKey = new Map(manifests.map((manifest) => [manifest.pluginKey, manifest]));
  const findings: CompatibilityFinding[] = [];
  for (const manifest of [...manifests].sort(byPluginKey)) {
    for (const requirement of [...manifest.requires].sort(byRequirementKey)) {
      const provider = byKey.get(requirement.pluginKey);
      if (!provider) {
        findings.push({
          code: "MISSING_DEPENDENCY",
          pluginKey: manifest.pluginKey,
          message:
            `${manifest.pluginKey} requires ${requirement.pluginKey}@${requirement.versionRange} ` +
            "but it is not part of the validated set"
        });
        continue;
      }
      if (!versionSatisfies(provider.pluginVersion, requirement.versionRange)) {
        findings.push({
          code: "DEPENDENCY_VERSION_UNSATISFIED",
          pluginKey: manifest.pluginKey,
          message:
            `${manifest.pluginKey} requires ${requirement.pluginKey}@${requirement.versionRange} ` +
            `but the set provides ${provider.pluginVersion}`
        });
      }
    }
  }
  return findings;
}

/** conflicts：被声明冲突的插件存在且版本落入冲突区间即拒。 */
export function findActiveConflicts(
  manifests: readonly PluginManifest[]
): CompatibilityFinding[] {
  const byKey = new Map(manifests.map((manifest) => [manifest.pluginKey, manifest]));
  const findings: CompatibilityFinding[] = [];
  for (const manifest of [...manifests].sort(byPluginKey)) {
    for (const conflict of [...manifest.conflicts].sort(byRequirementKey)) {
      const provider = byKey.get(conflict.pluginKey);
      if (provider && versionSatisfies(provider.pluginVersion, conflict.versionRange)) {
        findings.push({
          code: "CONFLICT_PRESENT",
          pluginKey: manifest.pluginKey,
          message:
            `${manifest.pluginKey} declares conflict with ${conflict.pluginKey}@${conflict.versionRange} ` +
            `but the set contains ${provider.pluginKey}@${provider.pluginVersion}`
        });
      }
    }
  }
  return findings;
}

export interface ManifestSetOptions {
  /** 宿主 API 版本（调用方显式传入；P-3 前无内置常量）。 */
  hostApiVersion: string;
}

export interface ManifestSetReport {
  ok: boolean;
  findings: CompatibilityFinding[];
  /** 通过全部单件门的清单（保持输入顺序；可供后续动态装载）。 */
  valid: PluginManifest[];
}

/**
 * 集合装载前门：逐件「schema → 宿主求交」，再跑集合级检查（越权 /
 * 重复键 / 依赖环 / 依赖缺失与版本 / 冲突）。任一层 findings 非空即
 * ok=false；调用方据此拒绝装载（fail-closed，不进入 registry）。
 */
export function verifyPluginManifestSet(
  inputs: readonly unknown[],
  options: ManifestSetOptions
): ManifestSetReport {
  const hostApiVersion = options.hostApiVersion;
  if (valid(hostApiVersion) === null) {
    return {
      ok: false,
      findings: [
        {
          code: "HOST_API_VERSION_INVALID",
          message: `invalid host API version: ${JSON.stringify(hostApiVersion)}`
        }
      ],
      valid: []
    };
  }

  const findings: CompatibilityFinding[] = [];
  const validManifests: PluginManifest[] = [];

  inputs.forEach((input, index) => {
    const parsed = pluginManifestSchema.safeParse(input);
    if (!parsed.success) {
      findings.push({
        code: "MANIFEST_INVALID",
        message: `invalid plugin manifest: ${formatIssues(parsed.error.issues)}`,
        detail: { index }
      });
      return;
    }
    const manifest = parsed.data;
    if (!evaluateHostApiCompatibility(hostApiVersion, manifest.hostApiRange)) {
      findings.push({
        code: "HOST_API_RANGE_UNSATISFIED",
        pluginKey: manifest.pluginKey,
        message: `host API ${hostApiVersion} does not satisfy hostApiRange ${JSON.stringify(manifest.hostApiRange)}`,
        detail: { index }
      });
      return;
    }
    validManifests.push(manifest);
  });

  findings.push(
    ...findSimulationWriteEscalations(validManifests),
    ...findDuplicatePluginKeys(validManifests),
    ...findDependencyCycles(validManifests),
    ...findUnresolvedDependencies(validManifests),
    ...findActiveConflicts(validManifests)
  );

  return { ok: findings.length === 0, findings, valid: validManifests };
}
