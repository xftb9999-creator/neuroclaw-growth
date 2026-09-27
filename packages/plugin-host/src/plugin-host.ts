/**
 * P2-1 · PluginHost 装载器（生产接线核心）。
 *
 * 链序（硬约束；P1-2 门必须在动态 import 之前，见 plugin-roadmap.md:297 与
 * `.artifacts/impl/2026-09-27-p1-2-3.md` §4.1 的下传义务）：
 *
 *   扫描目录 → 集合校验（verifyPluginManifestSet）→ 注册（enabled=false 状态机）
 *   → 显式激活（allowlist）→ 单件门（assertHostApiCompatible）→ 动态 import(entryPoint)
 *   → onLoad → enabled=true → onEnable
 *
 * 安全语义：
 * - **fail-closed**：未通过校验的清单不进入 registry、永不触达 import（门禁 1 前移）；
 * - **默认关闭**：只有显式 allowlist（`NEUROCLAW_PLUGIN_HOST_ENABLED`）中的插件才
 *   会被激活；G1「首次 enabled=true 运行期装载」属独立授权阈值（p2-readiness §4），
 *   默认值为空 = 生产默认零代码执行；
 * - **重入校验**：激活前再次运行单件门（防注册后清单漂移与未来 API 注册路径绕过）；
 * - 装载初始化本身**不设开关**：只要宿主启动（createApp 在默认启动路径上），
 *   扫描/校验/注册即执行——避免「死开关」。
 *
 * 范围边界：P2-1 只做「装载 + enabled 状态机 + registry.list()」。能力句柄与调用
 * 边界强制属 P2-2；插件级审计属 P2-3；五类恶意用例套件属 P2-4；同进程无真沙箱
 * （残余风险，范围锁第一方，见 plugin-roadmap §5.1）。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PluginCompatibilityError,
  assertHostApiCompatible,
  pluginManifestSchema,
  verifyPluginManifestSet,
  type CompatibilityFinding,
  type PluginManifest
} from "@neuroclaw/plugin-contract";

/** 扫描目标文件名后缀：与 P-0 规划的 `*.integration.json` 目录共存而互不误读。 */
export const PLUGIN_MANIFEST_FILE_SUFFIX = ".plugin.json";

/**
 * 宿主 API 版本默认值。P-3 定义 host × plugin 兼容矩阵前，与 P1-3 CLI 的
 * `--host-api` 默认值对齐（scripts/validate-plugin-manifest.mjs）；部署可用
 * `NEUROCLAW_HOST_API_VERSION` 显式覆盖。
 */
export const DEFAULT_HOST_API_VERSION = "1.0.0";

// ---------------------------------------------------------------------------
// §0 类型
// ---------------------------------------------------------------------------

/** enabled 状态机（roadmap P2-1：「注册（带 enabled 状态机）」）。 */
export type PluginHostLifecycleState =
  | "registered"
  | "loaded"
  | "enabled"
  | "disabled"
  | "rejected"
  | "failed";

export interface PluginHostEntry {
  pluginKey: string;
  pluginVersion: string | null;
  /** 清单文件绝对路径（相对 entryPoint 的解析基准）；API 注册路径可为 null。 */
  manifestPath: string | null;
  state: PluginHostLifecycleState;
  /** 是否已启用（默认 false；只有显式激活成功后才为 true）。 */
  enabled: boolean;
  /** 动态 import 是否曾被尝试（负向证据字段：被门拒绝的插件必须保持 false）。 */
  importAttempted: boolean;
  loadedAt: string | null;
  findings: readonly CompatibilityFinding[];
  error: string | null;
  manifest: PluginManifest | null;
}

export interface PluginHostRejection {
  file: string;
  pluginKey: string | null;
  findings: readonly CompatibilityFinding[];
}

export interface PluginHostInitReport {
  dir: string;
  dirExists: boolean;
  discovered: number;
  registered: number;
  rejected: number;
  /** 成功完成「import + onLoad + onEnable」的插件数。 */
  activated: number;
  findings: readonly CompatibilityFinding[];
  rejections: readonly PluginHostRejection[];
  startedAt: string;
  finishedAt: string;
}

export interface PluginHostLogEvent {
  level: "info" | "warn";
  event: "init" | "registered" | "rejected" | "enabled" | "disabled" | "skip";
  message: string;
  pluginKey?: string;
  detail?: Record<string, unknown>;
}

/** 动态 import 接缝（测试注入用；生产默认真实 import）。 */
export type PluginImporter = (specifier: string) => Promise<unknown>;

/** 单件门接缝（测试注入用；生产默认 P1-2 `assertHostApiCompatible`）。 */
export type PluginManifestVerifier = (
  manifest: PluginManifest,
  hostApiVersion: string
) => PluginManifest;

/** 生命周期钩子上下文（P2-1 最小 ABI；P3 冻结扩展）。 */
export interface PluginHookContext {
  manifest: PluginManifest;
  hostApiVersion: string;
  logger: (message: string) => void;
}

export interface PluginHostOptions {
  /** 宿主 API 版本（调用方显式传入；本模块不内置协议常量）。 */
  hostApiVersion: string;
  /** 插件清单目录（扫描一层 `*.plugin.json`，按文件名排序）。 */
  pluginsDir: string;
  /**
   * 允许激活的 pluginKey 显式清单（默认 []）。空 = 只注册不装载（生产默认，
   * G1 定点确认前必须保持为空）。
   */
  enabledPluginKeys?: readonly string[];
  importer?: PluginImporter;
  verifyManifest?: PluginManifestVerifier;
  logger?: (event: PluginHostLogEvent) => void;
  now?: () => Date;
}

export type PluginHostErrorCode =
  | "PLUGIN_NOT_REGISTERED"
  | "PLUGIN_REJECTED"
  | "PLUGIN_NOT_ENABLED"
  | "PLUGIN_ACTIVATION_FAILED";

export class PluginHostError extends Error {
  readonly code: PluginHostErrorCode;

  constructor(code: PluginHostErrorCode, message: string) {
    super(message);
    this.name = "PluginHostError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// §1 工具（确定性、纯函数优先）
// ---------------------------------------------------------------------------

function manifestTuple(manifest: PluginManifest): string {
  return `${manifest.pluginKey}@${manifest.pluginVersion}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * entryPoint 解析：相对路径（`.` 开头）与绝对路径解析为基于清单目录的 file URL；
 * 裸包名原样交给 import()。模块内导出符号语法（`path#symbol`）P2-1 不解释
 * （格式未冻结，属 P3 待决项）。
 */
export function resolveModuleSpecifier(
  entryPoint: string,
  manifestPath: string | null,
  fallbackDir: string
): string {
  if (!entryPoint.startsWith(".") && !path.isAbsolute(entryPoint)) return entryPoint;
  const baseDir = manifestPath ? path.dirname(manifestPath) : fallbackDir;
  const absolute = path.isAbsolute(entryPoint) ? entryPoint : path.resolve(baseDir, entryPoint);
  return pathToFileURL(absolute).href;
}

function defaultLogger(event: PluginHostLogEvent): void {
  const key = event.pluginKey ? ` ${event.pluginKey}` : "";
  const line = `[plugin-host] ${event.event}${key}: ${event.message}`;
  if (event.level === "warn") console.warn(line);
  else console.log(line);
}

// ---------------------------------------------------------------------------
// §2 PluginHost
// ---------------------------------------------------------------------------

export class PluginHost {
  readonly hostApiVersion: string;
  readonly pluginsDir: string;

  private readonly enabledPluginKeys: ReadonlySet<string>;
  private readonly importer: PluginImporter;
  private readonly verifyManifest: PluginManifestVerifier;
  private readonly logger: (event: PluginHostLogEvent) => void;
  private readonly now: () => Date;

  private readonly entries = new Map<string, PluginHostEntry>();
  private readonly modules = new Map<string, unknown>();
  private initPromise: Promise<PluginHostInitReport> | null = null;
  private lastReport: PluginHostInitReport | null = null;

  constructor(options: PluginHostOptions) {
    this.hostApiVersion = options.hostApiVersion;
    this.pluginsDir = options.pluginsDir;
    this.enabledPluginKeys = new Set(options.enabledPluginKeys ?? []);
    this.importer = options.importer ?? ((specifier) => import(specifier));
    this.verifyManifest = options.verifyManifest ?? assertHostApiCompatible;
    this.logger = options.logger ?? defaultLogger;
    this.now = options.now ?? (() => new Date());
  }

  /** 幂等初始化：扫描 → 集合校验 → 注册（enabled=false）→ 按 allowlist 激活。 */
  init(): Promise<PluginHostInitReport> {
    if (!this.initPromise) this.initPromise = this.runInit();
    return this.initPromise;
  }

  /** 最近一次初始化报告（未初始化时为 null）。 */
  getReport(): PluginHostInitReport | null {
    return this.lastReport ? { ...this.lastReport } : null;
  }

  /** registry 可视图（按 pluginKey 排序；被拒清单不进入 registry）。 */
  list(): PluginHostEntry[] {
    return [...this.entries.values()]
      .map((entry) => this.snapshot(entry))
      .sort((a, b) => (a.pluginKey < b.pluginKey ? -1 : a.pluginKey > b.pluginKey ? 1 : 0));
  }

  getEntry(pluginKey: string): PluginHostEntry | null {
    const entry = this.entries.get(pluginKey);
    return entry ? this.snapshot(entry) : null;
  }

  /**
   * 显式激活：单件门（import 之前）→ 动态 import（模块缓存命中则跳过）→
   * onLoad → enabled=true → onEnable。任一步失败不进入 enabled。
   */
  async enable(pluginKey: string): Promise<PluginHostEntry> {
    const entry = this.entries.get(pluginKey);
    if (!entry || entry.state === "rejected") {
      throw new PluginHostError(
        "PLUGIN_NOT_REGISTERED",
        `plugin ${JSON.stringify(pluginKey)} is not registered`
      );
    }
    if (entry.state === "enabled") return this.snapshot(entry);
    if (!entry.manifest) {
      throw new PluginHostError(
        "PLUGIN_NOT_REGISTERED",
        `plugin ${JSON.stringify(pluginKey)} has no verified manifest`
      );
    }

    // 1) 单件门 —— 必须在动态 import 之前（fail-closed）。
    let manifest: PluginManifest;
    try {
      manifest = this.verifyManifest(entry.manifest, this.hostApiVersion);
    } catch (error) {
      entry.state = "rejected";
      entry.enabled = false;
      entry.error = errorMessage(error);
      if (error instanceof PluginCompatibilityError) entry.findings = [errorToFinding(error), ...entry.findings];
      this.logger({
        level: "warn",
        event: "rejected",
        pluginKey,
        message: `activation refused before import: ${entry.error}`
      });
      throw error;
    }

    // 2) 动态 import（仅在门通过之后；模块缓存命中时跳过重复求值）。
    const alreadyLoaded = entry.loadedAt !== null;
    if (!this.modules.has(pluginKey)) {
      const specifier = resolveModuleSpecifier(manifest.entryPoint, entry.manifestPath, this.pluginsDir);
      entry.importAttempted = true;
      try {
        this.modules.set(pluginKey, await this.importer(specifier));
      } catch (error) {
        entry.state = "failed";
        entry.error = errorMessage(error);
        throw new PluginHostError(
          "PLUGIN_ACTIVATION_FAILED",
          `import failed for ${manifestTuple(manifest)}: ${entry.error}`
        );
      }
    }
    const module = this.modules.get(pluginKey);

    // 3) onLoad（仅首次装载）→ enabled → onEnable。
    try {
      if (!alreadyLoaded) {
        entry.state = "loaded";
        entry.loadedAt = this.now().toISOString();
        await this.callHook(module, "onLoad", manifest);
      }
      await this.callHook(module, "onEnable", manifest);
    } catch (error) {
      entry.state = "failed";
      entry.enabled = false;
      entry.error = errorMessage(error);
      throw new PluginHostError(
        "PLUGIN_ACTIVATION_FAILED",
        `lifecycle hook failed for ${manifestTuple(manifest)}: ${entry.error}`
      );
    }
    entry.enabled = true;
    entry.state = "enabled";
    this.logger({
      level: "info",
      event: "enabled",
      pluginKey,
      message: `enabled (entryPoint resolved, hooks onLoad/onEnable completed)`
    });
    return this.snapshot(entry);
  }

  /** 停用：调用 onDisable（best-effort）→ enabled=false。不可变语义下不回滚版本。 */
  async disable(pluginKey: string): Promise<PluginHostEntry> {
    const entry = this.entries.get(pluginKey);
    if (!entry || (entry.state !== "enabled" && entry.state !== "loaded")) {
      throw new PluginHostError(
        "PLUGIN_NOT_ENABLED",
        `plugin ${JSON.stringify(pluginKey)} is not enabled`
      );
    }
    const module = this.modules.get(pluginKey);
    if (module && entry.manifest) {
      try {
        await this.callHook(module, "onDisable", entry.manifest);
      } catch (error) {
        this.logger({
          level: "warn",
          event: "disabled",
          pluginKey,
          message: `onDisable hook failed (disable continues): ${errorMessage(error)}`
        });
      }
    }
    entry.enabled = false;
    entry.state = "disabled";
    this.logger({ level: "info", event: "disabled", pluginKey, message: "disabled" });
    return this.snapshot(entry);
  }

  // -------------------------------------------------------------------------
  // §2.1 init 内部
  // -------------------------------------------------------------------------

  private async runInit(): Promise<PluginHostInitReport> {
    const startedAt = this.now().toISOString();
    const findings: CompatibilityFinding[] = [];
    const rejections: PluginHostRejection[] = [];

    let dirExists = false;
    let files: string[] = [];
    try {
      const info = await stat(this.pluginsDir);
      dirExists = info.isDirectory();
      if (dirExists) {
        files = (await readdir(this.pluginsDir))
          .filter((file) => file.endsWith(PLUGIN_MANIFEST_FILE_SUFFIX))
          .sort();
      }
    } catch {
      dirExists = false;
    }

    const inputs: { file: string; input: unknown }[] = [];
    for (const file of files) {
      try {
        const raw = await readFile(path.join(this.pluginsDir, file), "utf8");
        inputs.push({ file, input: JSON.parse(raw) });
      } catch (error) {
        const finding: CompatibilityFinding = {
          code: "MANIFEST_INVALID",
          message: `cannot read/parse ${file}: ${errorMessage(error)}`,
          detail: { file }
        };
        findings.push(finding);
        rejections.push({ file, pluginKey: null, findings: [finding] });
      }
    }

    const setReport = verifyPluginManifestSet(
      inputs.map((entry) => entry.input),
      { hostApiVersion: this.hostApiVersion }
    );
    findings.push(...setReport.findings);

    const validTuples = new Set(setReport.valid.map((manifest) => manifestTuple(manifest)));

    for (const [index, { file, input }] of inputs.entries()) {
      const parsed = pluginManifestSchema.safeParse(input);
      const pluginKey = parsed.success ? parsed.data.pluginKey : null;
      const fileFindings = setReport.findings.filter((finding) => {
        if (finding.pluginKey) return pluginKey !== null && finding.pluginKey === pluginKey;
        const findingIndex = finding.detail?.index;
        if (typeof findingIndex === "number") return findingIndex === index;
        return true; // 全局 finding（如宿主版本非法）：挂到所有被拒项
      });

      // 拒绝条件：单件门失败（不在 valid 中）、集合级命中（越权/重复/环/依赖/冲突，
      // 这类 findings 不把清单移出 `valid`，必须显式拦截）或全局 finding。
      if (
        !parsed.success ||
        !validTuples.has(manifestTuple(parsed.data)) ||
        fileFindings.length > 0
      ) {
        const rejectionFindings =
          fileFindings.length > 0
            ? fileFindings
            : [
                {
                  code: "MANIFEST_INVALID" as const,
                  message: `manifest rejected without a specific finding: ${file}`
                }
              ];
        rejections.push({ file, pluginKey, findings: rejectionFindings });
        this.logger({
          level: "warn",
          event: "rejected",
          pluginKey: pluginKey ?? undefined,
          message: `${file}: ${rejectionFindings.map((finding) => finding.code).join(", ")} (not registered; import never attempted)`,
          detail: { file }
        });
        continue;
      }

      const manifest = parsed.data;
      this.entries.set(manifest.pluginKey, {
        pluginKey: manifest.pluginKey,
        pluginVersion: manifest.pluginVersion,
        manifestPath: path.join(this.pluginsDir, file),
        state: "registered",
        enabled: false,
        importAttempted: false,
        loadedAt: null,
        findings: [],
        error: null,
        manifest
      });
      this.logger({
        level: "info",
        event: "registered",
        pluginKey: manifest.pluginKey,
        message: `${manifest.pluginKey}@${manifest.pluginVersion} registered (enabled=false)`
      });
    }

    let activated = 0;
    for (const pluginKey of [...this.enabledPluginKeys].sort()) {
      const entry = this.entries.get(pluginKey);
      if (!entry || entry.state === "rejected") {
        this.logger({
          level: "warn",
          event: "skip",
          pluginKey,
          message: "activation skipped: not registered (rejected or missing)"
        });
        continue;
      }
      try {
        await this.enable(pluginKey);
        activated += 1;
      } catch (error) {
        this.logger({
          level: "warn",
          event: "skip",
          pluginKey,
          message: `activation failed: ${errorMessage(error)}`
        });
      }
    }

    const finishedAt = this.now().toISOString();
    const report: PluginHostInitReport = {
      dir: this.pluginsDir,
      dirExists,
      discovered: files.length,
      registered: this.entries.size,
      rejected: rejections.length,
      activated,
      findings,
      rejections,
      startedAt,
      finishedAt
    };
    this.lastReport = report;
    this.logger({
      level: "info",
      event: "init",
      message:
        `scan dir=${this.pluginsDir} exists=${dirExists} discovered=${report.discovered} ` +
        `registered=${report.registered} rejected=${report.rejected} activated=${report.activated}`,
      detail: { hostApiVersion: this.hostApiVersion }
    });
    return report;
  }

  // -------------------------------------------------------------------------
  // §2.2 私有工具
  // -------------------------------------------------------------------------

  private async callHook(
    module: unknown,
    hook: "onLoad" | "onEnable" | "onDisable",
    manifest: PluginManifest
  ): Promise<void> {
    if (module === null || module === undefined) return;
    const namespace = module as Record<string, unknown>;
    const defaultExport = namespace.default;
    const surface =
      typeof defaultExport === "object" && defaultExport !== null
        ? (defaultExport as Record<string, unknown>)
        : namespace;
    const candidate = surface[hook];
    if (typeof candidate !== "function") return;
    const context: PluginHookContext = {
      manifest,
      hostApiVersion: this.hostApiVersion,
      logger: (message: string) =>
        this.logger({ level: "info", event: "init", pluginKey: manifest.pluginKey, message })
    };
    await (candidate as (ctx: PluginHookContext) => unknown).call(surface, context);
  }

  private snapshot(entry: PluginHostEntry): PluginHostEntry {
    return { ...entry, findings: [...entry.findings] };
  }
}

function errorToFinding(error: PluginCompatibilityError): CompatibilityFinding {
  return {
    code: error.code,
    message: error.message,
    pluginKey: typeof error.detail.pluginKey === "string" ? error.detail.pluginKey : undefined,
    detail: error.detail
  };
}

// ---------------------------------------------------------------------------
// §3 运行时配置与生产 bootstrap
// ---------------------------------------------------------------------------

/**
 * 从环境解析宿主配置（显式、可覆盖、零隐式默认协议新增）：
 * - `NEUROCLAW_PLUGINS_DIR`   清单目录（默认 `<cwd>/plugins`）；
 * - `NEUROCLAW_HOST_API_VERSION`（默认 {@link DEFAULT_HOST_API_VERSION}，P-3 后由矩阵提供）；
 * - `NEUROCLAW_PLUGIN_HOST_ENABLED` 允许激活的 pluginKey 逗号清单（默认空 = 零代码执行）。
 */
export function resolvePluginHostConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): PluginHostOptions {
  const enabledPluginKeys = (env.NEUROCLAW_PLUGIN_HOST_ENABLED ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const hostApiVersion = (env.NEUROCLAW_HOST_API_VERSION ?? "").trim();
  const pluginsDir = (env.NEUROCLAW_PLUGINS_DIR ?? "").trim();
  return {
    hostApiVersion: hostApiVersion || DEFAULT_HOST_API_VERSION,
    pluginsDir: pluginsDir || path.resolve(cwd, "plugins"),
    enabledPluginKeys
  };
}

/**
 * 生产接线入口（app.ts 唯一挂载点调用）：创建实例并点火 init。
 * init 自身永不 reject（内部逐项捕获）；此处的 catch 仅为防御性兜底。
 */
export function bootstrapPluginHost(options: PluginHostOptions): PluginHost {
  const host = new PluginHost(options);
  void host.init().catch((error) => {
    const logger = options.logger ?? defaultLogger;
    logger({
      level: "warn",
      event: "init",
      message: `plugin host init failed (fail-safe, host continues): ${errorMessage(error)}`
    });
  });
  return host;
}
