/**
 * P2-2 · 能力句柄与调用边界强制（宿主强制门禁）。
 *
 * 口径来源（先核实后动笔）：
 * - `plugin-roadmap.md:298`（P2-2：调用边界求交、能力句柄替代裸 db/network/fs、
 *   `writeScopes` 非空 ⇒ CONTROLLED_WRITE 授权链；验收＝越权调用被拒＋明确错误码）；
 * - `plugin-roadmap.md:402`（simulationOnly 只能收紧不能放宽；判定在调用边界而非
 *   清单解析；清单声明 ∩ 宿主强制＝∅ ⇒ 拒绝装载）；
 * - `plugin.md §5` 机制 2/3（宿主强制而非插件自声明；能力句柄；四引用齐全）；
 * - `p2-readiness` §1 门禁 2/3、§3 阶段 3（产物与验收）。
 *
 * 安全语义（硬约束）：
 * 1. **默认拒绝**：不声明＝无权限（plugin.md §3.1）；宿主侧默认策略亦不授予任何
 *    读/写范围——授予必须由宿主部署显式配置（`PluginCapabilityPolicy`）。
 * 2. **求交而非信任**：有效能力＝清单声明 ∩ 宿主策略；`simulationOnly` 取
 *    「清单声明 ∨ 宿主要求」（只能收紧不能放宽）。交集为空（如宿主要求
 *    simulation-only 而清单声明 live）⇒ 装载期拒绝
 *    （{@link assertPluginCapabilitiesGrantable}，在动态 import 之前）。
 * 3. **判定在调用边界**：句柄每个方法在调用瞬间校验（而非装载时一次信任）；
 *    simulationOnly 的运行期写阻断同样只发生在调用边界（清单解析不豁免）。
 * 4. **写路径必过授权链**：`writeScopes` 非空 ⇒ 每次写调用都必须经
 *    `assertControlledWriteAuthorized`（@neuroclaw/shared `universal-contracts.ts:1307+`；
 *    四引用＋版本钉＋binding＋approval）；授权证据只能由宿主侧 resolver 提供——
 *    插件自带对象不构成授权（真实证据落执行体属 P4-1，本阶段为显式接缝）。
 * 5. **不发放裸访问**：插件拿不到 db/network/fs 句柄；`network`/`filesystem`
 *    仅提供显式拒绝桩（明确错误码），本阶段不发放真实网络/文件能力。
 *
 * 非目标（阶段边界）：真实 IO 代理与策略/预算/审批的存储解析（P4-1）；P2-3 的越权
 * 拒绝审计由 `emitDenial` 接缝提供（落盘 sink 由宿主注入，见 ./plugin-audit.ts）；
 * 五类恶意负向套件（P2-4）；同进程无真沙箱（残余风险，roadmap §5.1）。
 */
import {
  assertControlledWriteAuthorized,
  type ControlledWriteAuthorizationInput
} from "@neuroclaw/shared";

import type { PluginManifest } from "@neuroclaw/plugin-contract";

import { emitPluginAudit, type PluginAuditSink } from "./plugin-audit.js";

// ---------------------------------------------------------------------------
// §1 宿主能力策略（宿主强制授权源；清单只能收紧）
// ---------------------------------------------------------------------------

/**
 * 宿主能力策略。缺省（未配置）时为最严：要求 simulation-only 插件且零读/写授予
 * ——任何放行都必须由部署显式声明（fail-closed）。
 */
export interface PluginCapabilityPolicy {
  /**
   * 宿主是否要求插件声明 `simulationOnly=true`。默认 true（G1 定点确认前口径）。
   * 若为 true 而清单声明 live（false）⇒ 声明 ∩ 强制 = ∅ ⇒ 装载期拒绝。
   * 宿主为 true 时清单 false 不能放宽；清单 true 时宿主 false 也不能放宽
   * （有效模式取「或」，见 {@link resolveEffectivePluginCapabilities}）。
   */
  requireSimulationOnly?: boolean;
  /** 宿主授予的读范围（与清单 readScopes 求交）；默认 []。 */
  allowedReadScopes?: readonly string[];
  /** 宿主授予的写范围（与清单 writeScopes 求交）；默认 []。 */
  allowedWriteScopes?: readonly string[];
}

export interface ResolvedPluginCapabilityPolicy {
  requireSimulationOnly: boolean;
  allowedReadScopes: readonly string[];
  allowedWriteScopes: readonly string[];
}

/** 缺省策略：最严（simulation-only 必须；零读/写授予）。 */
export const DEFAULT_PLUGIN_CAPABILITY_POLICY: ResolvedPluginCapabilityPolicy = Object.freeze({
  requireSimulationOnly: true,
  allowedReadScopes: Object.freeze([]) as readonly string[],
  allowedWriteScopes: Object.freeze([]) as readonly string[]
});

/** 归一化策略（填充默认值；不修改入参）。 */
export function resolvePluginCapabilityPolicy(
  policy?: PluginCapabilityPolicy
): ResolvedPluginCapabilityPolicy {
  return {
    requireSimulationOnly:
      policy?.requireSimulationOnly ?? DEFAULT_PLUGIN_CAPABILITY_POLICY.requireSimulationOnly,
    allowedReadScopes: [...(policy?.allowedReadScopes ?? DEFAULT_PLUGIN_CAPABILITY_POLICY.allowedReadScopes)],
    allowedWriteScopes: [...(policy?.allowedWriteScopes ?? DEFAULT_PLUGIN_CAPABILITY_POLICY.allowedWriteScopes)]
  };
}

// ---------------------------------------------------------------------------
// §2 求交结果与装载期空交集门
// ---------------------------------------------------------------------------

export interface EffectivePluginCapabilities {
  /** 有效 simulation 模式 = 清单声明 ∨ 宿主要求（只能收紧不能放宽）。 */
  simulationOnly: boolean;
  /** 有效读范围 = 清单 readScopes ∩ 宿主 allowedReadScopes。 */
  readScopes: readonly string[];
  /** 有效写范围 = 清单 writeScopes ∩ 宿主 allowedWriteScopes。 */
  writeScopes: readonly string[];
  /** 被宿主策略从未授予的清单范围（观测/审计用，不参与放行）。 */
  withheldReadScopes: readonly string[];
  withheldWriteScopes: readonly string[];
}

/** 计算有效能力（纯函数；调用边界与装载期共用同一求交语义）。 */
export function resolveEffectivePluginCapabilities(
  manifest: PluginManifest,
  policy?: PluginCapabilityPolicy
): EffectivePluginCapabilities {
  const resolved = resolvePluginCapabilityPolicy(policy);
  const readScopes = manifest.readScopes.filter((scope) => resolved.allowedReadScopes.includes(scope));
  const writeScopes = manifest.writeScopes.filter((scope) => resolved.allowedWriteScopes.includes(scope));
  return {
    simulationOnly: manifest.simulationOnly || resolved.requireSimulationOnly,
    readScopes,
    writeScopes,
    withheldReadScopes: manifest.readScopes.filter((scope) => !readScopes.includes(scope)),
    withheldWriteScopes: manifest.writeScopes.filter((scope) => !writeScopes.includes(scope))
  };
}

// ---------------------------------------------------------------------------
// §3 明确错误码
// ---------------------------------------------------------------------------

export type PluginCapabilityErrorCode =
  /** 装载期：清单声明 ∩ 宿主强制 = ∅（如宿主要求 simulation-only 而清单声明 live）。 */
  | "CAPABILITY_GRANT_EMPTY"
  /** 读：清单未声明该范围（默认拒绝）。 */
  | "CAPABILITY_READ_NOT_DECLARED"
  /** 读：宿主策略未授予该范围（求交为空）。 */
  | "CAPABILITY_READ_NOT_GRANTED"
  /** 写：清单 writeScopes 未声明该范围（默认拒绝）。 */
  | "CAPABILITY_WRITE_NOT_DECLARED"
  /** 写：宿主策略未授予该范围（求交为空）。 */
  | "CAPABILITY_WRITE_NOT_GRANTED"
  /** 写：有效模式为 simulation-only（调用边界阻断；只能收紧不能放宽）。 */
  | "CAPABILITY_SIMULATION_ONLY_BLOCKED"
  /** 写：CONTROLLED_WRITE 授权链未通过（缺证据／链拒绝）。 */
  | "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED"
  /** 网络：本阶段不发放（显式拒绝桩）。 */
  | "CAPABILITY_NETWORK_NOT_GRANTED"
  /** 文件系统：本阶段不发放（显式拒绝桩）。 */
  | "CAPABILITY_FILESYSTEM_NOT_GRANTED"
  /** 句柄已撤销（插件被 disable 后任何调用均在调用边界被拒）。 */
  | "CAPABILITY_HANDLE_REVOKED";

export class PluginCapabilityError extends Error {
  readonly code: PluginCapabilityErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: PluginCapabilityErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "PluginCapabilityError";
    this.code = code;
    this.detail = detail;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// §4 装载期门：声明 ∩ 宿主强制 = ∅ ⇒ 拒绝装载（在 import 之前）
// ---------------------------------------------------------------------------

/**
 * 能力授予门（装载期；enable 在动态 import 之前调用）。
 * 当前空交集判定（plugin-roadmap.md:402）：宿主要求 simulation-only 而清单声明
 * `simulationOnly=false` ⇒ 拒绝装载（而不是静默以更严模式运行——声明与强制不可调和）。
 * 通过后返回有效能力（供句柄发放）。
 */
export function assertPluginCapabilitiesGrantable(
  manifest: PluginManifest,
  policy?: PluginCapabilityPolicy
): EffectivePluginCapabilities {
  const resolved = resolvePluginCapabilityPolicy(policy);
  if (resolved.requireSimulationOnly && manifest.simulationOnly !== true) {
    throw new PluginCapabilityError(
      "CAPABILITY_GRANT_EMPTY",
      `plugin ${manifest.pluginKey} declares simulationOnly=false while the host requires ` +
        `simulation-only plugins: declared ∩ enforced = ∅ (refused before import)`,
      {
        pluginKey: manifest.pluginKey,
        declaredSimulationOnly: manifest.simulationOnly,
        hostRequireSimulationOnly: true
      }
    );
  }
  return resolveEffectivePluginCapabilities(manifest, resolved);
}

// ---------------------------------------------------------------------------
// §5 能力句柄（调用边界）
// ---------------------------------------------------------------------------

export interface PluginControlledWriteRequest {
  /** 请求写入的声明范围（必须 ∈ writeScopes ∩ 宿主授予）。 */
  scope: string;
  /** CONTROLLED_WRITE 行为目标（供链路 binding 校验）。 */
  actionRef: string;
  resourceRef: string;
}

export interface ControlledWriteResolverRequest {
  pluginKey: string;
  pluginVersion: string;
  writeScope: string;
  actionRef: string;
  resourceRef: string;
}

/**
 * 宿主侧 CONTROLLED_WRITE 证据解析器（P4-1 落真实执行体；本阶段为接缝）。
 * 返回 `null` = 无证据 ⇒ 拒绝；返回证据 ⇒ 交授权链求值。
 * 证据只能由宿主提供——插件传入的对象不具有授权地位。
 */
export type ControlledWriteAuthorizationResolver = (
  request: ControlledWriteResolverRequest
) => ControlledWriteAuthorizationInput | null | Promise<ControlledWriteAuthorizationInput | null>;

/** 授权链求值接缝（测试注入用；生产默认 shared `assertControlledWriteAuthorized`）。 */
export type ControlledWriteGate = (input: ControlledWriteAuthorizationInput) => void;

export interface CapabilityGrant {
  pluginKey: string;
  kind: "read" | "write";
  scope: string;
  actionRef: string | null;
  resourceRef: string | null;
  grantedAt: string;
}

/** 插件运行时唯一的能力授权面（经生命周期钩子 ctx.capabilities 发放）。 */
export interface PluginCapabilityHandle {
  readonly pluginKey: string;
  readonly simulationOnly: boolean;
  readonly grantedReadScopes: readonly string[];
  readonly grantedWriteScopes: readonly string[];
  readonly revoked: boolean;
  read(scope: string): CapabilityGrant;
  write(request: PluginControlledWriteRequest): Promise<CapabilityGrant>;
  /** 网络访问桩：本阶段不发放（显式错误码，替代裸 fetch/网络句柄）。 */
  readonly network: { request(descriptor: string): never };
  /** 文件系统访问桩：本阶段不发放（显式错误码，替代裸 fs 句柄）。 */
  readonly filesystem: { access(target: string): never };
  /** 撤销句柄（宿主在 disable 后调用；撤销后任何调用在调用边界被拒）。 */
  revoke(): void;
}

export interface PluginCapabilityHandleOptions {
  manifest: PluginManifest;
  policy?: PluginCapabilityPolicy;
  authorizeControlledWrite?: ControlledWriteAuthorizationResolver;
  assertControlledWrite?: ControlledWriteGate;
  /** P2-3 审计落盘接缝：越权拒绝事件经此下沉（缺省＝不落审计）。 */
  auditSink?: PluginAuditSink;
  /** P2-3 sink 故障回调（永不阻断拒绝路径）；缺省＝静默降级。 */
  onAuditError?: (message: string) => void;
  now?: () => Date;
}

/**
 * 发放能力句柄。调用边界校验顺序（写路径）：
 * 撤销 → simulation-only（先于一切写检查；无法被声明绕过）→ writeScopes 声明 →
 * 宿主授予（求交）→ CONTROLLED_WRITE 授权链（resolver 证据 + 链求值）。
 */
export function createPluginCapabilityHandle(
  options: PluginCapabilityHandleOptions
): PluginCapabilityHandle {
  const { manifest } = options;
  const effective = resolveEffectivePluginCapabilities(manifest, options.policy);
  const authorizeControlledWrite = options.authorizeControlledWrite;
  const assertControlledWrite = options.assertControlledWrite ?? assertControlledWriteAuthorized;
  const now = options.now ?? (() => new Date());
  let revoked = false;

  /** P2-3 拒绝审计发射：在抛错前调用；sink 故障永不阻断拒绝路径。 */
  const emitDenial = (
    operation: string,
    code: PluginCapabilityErrorCode,
    detail: Record<string, unknown> = {}
  ): void => {
    emitPluginAudit(
      options.auditSink,
      {
        eventType: "plugin.denied",
        pluginKey: manifest.pluginKey,
        pluginVersion: manifest.pluginVersion,
        occurredAt: now().toISOString(),
        code,
        detail: { operation, ...detail }
      },
      options.onAuditError
    );
  };

  const ensureActive = (operation: string): void => {
    if (revoked) {
      emitDenial(operation, "CAPABILITY_HANDLE_REVOKED");
      throw new PluginCapabilityError(
        "CAPABILITY_HANDLE_REVOKED",
        `capability handle for plugin ${manifest.pluginKey} has been revoked; ${operation} refused`,
        { pluginKey: manifest.pluginKey, operation }
      );
    }
  };

  return {
    pluginKey: manifest.pluginKey,
    simulationOnly: effective.simulationOnly,
    grantedReadScopes: [...effective.readScopes],
    grantedWriteScopes: [...effective.writeScopes],
    get revoked(): boolean {
      return revoked;
    },

    read(scope: string): CapabilityGrant {
      ensureActive("read");
      if (!manifest.readScopes.includes(scope)) {
        emitDenial("read", "CAPABILITY_READ_NOT_DECLARED", { scope });
        throw new PluginCapabilityError(
          "CAPABILITY_READ_NOT_DECLARED",
          `plugin ${manifest.pluginKey} read scope ${JSON.stringify(scope)} is not declared in ` +
            `manifest readScopes (default deny)`,
          { pluginKey: manifest.pluginKey, scope }
        );
      }
      if (!effective.readScopes.includes(scope)) {
        emitDenial("read", "CAPABILITY_READ_NOT_GRANTED", { scope });
        throw new PluginCapabilityError(
          "CAPABILITY_READ_NOT_GRANTED",
          `plugin ${manifest.pluginKey} read scope ${JSON.stringify(scope)} is not granted by the ` +
            `host capability policy (declared ∩ granted = ∅)`,
          { pluginKey: manifest.pluginKey, scope }
        );
      }
      return {
        pluginKey: manifest.pluginKey,
        kind: "read",
        scope,
        actionRef: null,
        resourceRef: null,
        grantedAt: now().toISOString()
      };
    },

    async write(request: PluginControlledWriteRequest): Promise<CapabilityGrant> {
      ensureActive("write");
      // 1) simulation-only 阻断：先于声明/授予检查；声明或宿主任一为 sim ⇒ 阻断
      //    （只能收紧不能放宽——即使 writeScopes 已声明且宿主已授予）。
      if (effective.simulationOnly) {
        emitDenial("write", "CAPABILITY_SIMULATION_ONLY_BLOCKED", {
          scope: request.scope,
          actionRef: request.actionRef,
          resourceRef: request.resourceRef
        });
        throw new PluginCapabilityError(
          "CAPABILITY_SIMULATION_ONLY_BLOCKED",
          `plugin ${manifest.pluginKey} write to ${JSON.stringify(request.scope)} blocked at the call ` +
            `boundary: effective mode is simulation-only (manifest declaration and host policy are ` +
            `intersected; declared permissions can only tighten, never relax)`,
          { pluginKey: manifest.pluginKey, scope: request.scope, actionRef: request.actionRef, resourceRef: request.resourceRef }
        );
      }
      // 2) 清单声明（默认拒绝：writeScopes 空 = 无写权限）。
      if (!manifest.writeScopes.includes(request.scope)) {
        emitDenial("write", "CAPABILITY_WRITE_NOT_DECLARED", { scope: request.scope });
        throw new PluginCapabilityError(
          "CAPABILITY_WRITE_NOT_DECLARED",
          `plugin ${manifest.pluginKey} write scope ${JSON.stringify(request.scope)} is not declared ` +
            `in manifest writeScopes (default deny)`,
          { pluginKey: manifest.pluginKey, scope: request.scope }
        );
      }
      // 3) 宿主授予（求交）。
      if (!effective.writeScopes.includes(request.scope)) {
        emitDenial("write", "CAPABILITY_WRITE_NOT_GRANTED", { scope: request.scope });
        throw new PluginCapabilityError(
          "CAPABILITY_WRITE_NOT_GRANTED",
          `plugin ${manifest.pluginKey} write scope ${JSON.stringify(request.scope)} is not granted ` +
            `by the host capability policy (declared ∩ granted = ∅)`,
          { pluginKey: manifest.pluginKey, scope: request.scope }
        );
      }
      // 4) CONTROLLED_WRITE 授权链：writeScopes 非空 ⇒ 每次写调用必过链。
      if (!authorizeControlledWrite) {
        emitDenial("write", "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED", {
          scope: request.scope,
          cause: "no-resolver"
        });
        throw new PluginCapabilityError(
          "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED",
          `plugin ${manifest.pluginKey} write to ${JSON.stringify(request.scope)} requires ` +
            `CONTROLLED_WRITE authorization, but the host has no authorization resolver configured`,
          { pluginKey: manifest.pluginKey, scope: request.scope, cause: "no-resolver" }
        );
      }
      let evidence: ControlledWriteAuthorizationInput | null;
      try {
        evidence = await authorizeControlledWrite({
          pluginKey: manifest.pluginKey,
          pluginVersion: manifest.pluginVersion,
          writeScope: request.scope,
          actionRef: request.actionRef,
          resourceRef: request.resourceRef
        });
      } catch (error) {
        emitDenial("write", "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED", {
          scope: request.scope,
          cause: errorMessage(error)
        });
        throw new PluginCapabilityError(
          "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED",
          `plugin ${manifest.pluginKey} write to ${JSON.stringify(request.scope)} denied: ` +
            `authorization resolver failed: ${errorMessage(error)}`,
          { pluginKey: manifest.pluginKey, scope: request.scope, cause: errorMessage(error) }
        );
      }
      if (!evidence) {
        emitDenial("write", "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED", {
          scope: request.scope,
          cause: "no-evidence"
        });
        throw new PluginCapabilityError(
          "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED",
          `plugin ${manifest.pluginKey} write to ${JSON.stringify(request.scope)} denied: ` +
            `host resolver returned no authorization evidence`,
          { pluginKey: manifest.pluginKey, scope: request.scope, cause: "no-evidence" }
        );
      }
      try {
        assertControlledWrite(evidence);
      } catch (error) {
        emitDenial("write", "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED", {
          scope: request.scope,
          cause: errorMessage(error)
        });
        throw new PluginCapabilityError(
          "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED",
          `plugin ${manifest.pluginKey} write to ${JSON.stringify(request.scope)} denied by the ` +
            `CONTROLLED_WRITE chain: ${errorMessage(error)}`,
          { pluginKey: manifest.pluginKey, scope: request.scope, cause: errorMessage(error) }
        );
      }
      return {
        pluginKey: manifest.pluginKey,
        kind: "write",
        scope: request.scope,
        actionRef: request.actionRef,
        resourceRef: request.resourceRef,
        grantedAt: now().toISOString()
      };
    },

    network: {
      request(descriptor: string): never {
        ensureActive("network");
        emitDenial("network", "CAPABILITY_NETWORK_NOT_GRANTED", { descriptor });
        throw new PluginCapabilityError(
          "CAPABILITY_NETWORK_NOT_GRANTED",
          `plugin ${manifest.pluginKey} network access is not available through the capability ` +
            `handle (P2-2 issues no network capability): ${descriptor}`,
          { pluginKey: manifest.pluginKey, descriptor }
        );
      }
    },

    filesystem: {
      access(target: string): never {
        ensureActive("filesystem");
        emitDenial("filesystem", "CAPABILITY_FILESYSTEM_NOT_GRANTED", { target });
        throw new PluginCapabilityError(
          "CAPABILITY_FILESYSTEM_NOT_GRANTED",
          `plugin ${manifest.pluginKey} filesystem access is not available through the capability ` +
            `handle (P2-2 issues no filesystem capability): ${target}`,
          { pluginKey: manifest.pluginKey, target }
        );
      }
    },

    revoke(): void {
      revoked = true;
    }
  };
}
