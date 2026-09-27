/**
 * P2-2 · 能力句柄 / 调用边界强制 测试。
 *
 * 覆盖判据（plugin-roadmap.md:298 / :402；p2-readiness §3 阶段 3）：
 * 1. 求交语义：有效能力＝清单声明 ∩ 宿主策略；simulationOnly 只能收紧不能放宽；
 * 2. 装载期空交集 ⇒ 拒绝装载（且 import 从未发生）；
 * 3. 调用边界拒绝：每类越权均有明确错误码；
 * 4. writeScopes 非空 ⇒ 必过 CONTROLLED_WRITE 授权链（真实 shared 链正/反向）；
 * 5. 运行时负向证据：真实动态 import 的插件在运行期被调用边界拒绝（金丝雀收据）。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  pluginManifestSchema,
  type PluginManifest
} from "@neuroclaw/plugin-contract";
import {
  adapterManifestSchema,
  approvalSchema,
  budgetSchema,
  killSwitchSchema,
  pilotAdapterManifests,
  policySchema,
  revocationSchema,
  type ControlledWriteAuthorizationInput
} from "@neuroclaw/shared";

import {
  PluginCapabilityError,
  assertPluginCapabilitiesGrantable,
  createPluginCapabilityHandle,
  resolveEffectivePluginCapabilities,
  type PluginCapabilityPolicy
} from "./capability-handle.js";
import { DEFAULT_HOST_API_VERSION, PluginHost, type PluginHookContext } from "./plugin-host.js";

// ---------------------------------------------------------------------------
// §0 工具
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const silent = { logger: () => {} };

function manifest(overrides: Record<string, unknown> = {}): PluginManifest {
  return pluginManifestSchema.parse({
    pluginKey: "probe_pack",
    pluginVersion: "1.0.0",
    pluginKind: "PACK",
    publisherRef: "neuroclaw.internal",
    hostApiRange: ">=1.0.0 <2.0.0",
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    entryPoint: "./entry.mjs",
    riskClass: "LOW",
    simulationOnly: true,
    ...overrides
  });
}

async function writeManifest(
  dir: string,
  fileName: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const payload = {
    pluginKey: "probe_pack",
    pluginVersion: "1.0.0",
    pluginKind: "PACK",
    publisherRef: "neuroclaw.internal",
    hostApiRange: ">=1.0.0 <2.0.0",
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    entryPoint: "./entry.mjs",
    riskClass: "LOW",
    simulationOnly: true,
    ...overrides
  };
  await writeFile(path.join(dir, fileName), JSON.stringify(payload, null, 2));
}

function spyImporter(): { imports: string[]; importer: (specifier: string) => Promise<unknown> } {
  const imports: string[] = [];
  return {
    imports,
    importer: async (specifier: string) => {
      imports.push(specifier);
      return {
        async onLoad(): Promise<void> {},
        async onEnable(): Promise<void> {}
      };
    }
  };
}

async function captureCapabilityError(operation: () => unknown): Promise<PluginCapabilityError> {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(PluginCapabilityError);
    return error as PluginCapabilityError;
  }
  throw new Error("expected operation to be rejected");
}

/** 有效的 CONTROLLED_WRITE 证据（复用 shared 夹具，形状与 universal-contracts.test.ts:451-553 一致）。 */
function validControlledWriteEvidence(): ControlledWriteAuthorizationInput {
  const timestamp = "2026-09-28T00:00:00.000Z";
  const entity = {
    schemaVersion: "1.0",
    scope: { organizationId: "org_simulation", workspaceId: "ws_simulation", projectId: "prj_uaos" },
    createdBy: "operator_demo",
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceRefs: ["fixture:uaos"]
  };
  const policy = policySchema.parse({
    ...entity,
    id: "policy_uaos_v1",
    policyKey: "uaos-control",
    version: "1.0.0",
    actionClass: "CONTROLLED_WRITE",
    riskClass: "HIGH",
    decision: "REQUIRE_APPROVAL",
    requiresApproval: true,
    subjectRef: "adapter_uaos_simulation",
    actionRef: "publish_result",
    resourceRef: "resource_campaign_uaos",
    budgetRef: "budget_uaos_v1",
    revocationRef: "revocation_uaos_v1",
    killSwitchRef: "kill_uaos_v1",
    status: "ACTIVE"
  });
  const budget = budgetSchema.parse({
    ...entity,
    id: "budget_uaos_v1",
    budgetKey: "uaos-budget",
    version: "1.0.0",
    unit: "simulation_units",
    limit: 100,
    consumed: 0,
    subjectRef: "adapter_uaos_simulation",
    resourceRef: "resource_campaign_uaos",
    status: "ACTIVE"
  });
  const approval = approvalSchema.parse({
    ...entity,
    id: "approval_uaos_v1",
    policyRef: policy.id,
    policyVersion: policy.version,
    actionClass: "CONTROLLED_WRITE",
    subjectRef: "adapter_uaos_simulation",
    actionRef: "publish_result",
    resourceRef: "resource_campaign_uaos",
    requestedBy: "operator_demo",
    approverRef: "reviewer_demo",
    status: "APPROVED",
    requestedAt: timestamp,
    decidedAt: timestamp
  });
  const revocation = revocationSchema.parse({
    ...entity,
    id: "revocation_uaos_v1",
    version: "1.0.0",
    targetRef: "adapter_uaos_simulation",
    resourceRef: "resource_campaign_uaos",
    reason: "manual stop line",
    status: "REVOKED",
    effectiveAt: timestamp
  });
  const killSwitch = killSwitchSchema.parse({
    ...entity,
    id: "kill_uaos_v1",
    version: "1.0.0",
    targetRef: "adapter_uaos_simulation",
    resourceRef: "resource_campaign_uaos",
    reason: "emergency stop",
    state: "ARMED"
  });
  const controlledManifest = adapterManifestSchema.parse({
    ...pilotAdapterManifests.uaos,
    status: "CONTROLLED_WRITE",
    writeScopes: ["project:write"],
    policyRef: policy.id,
    policyVersion: policy.version,
    budgetRef: budget.id,
    budgetVersion: budget.version,
    approvalRefs: [approval.id],
    revocationRef: revocation.id,
    revocationVersion: revocation.version,
    killSwitchRef: killSwitch.id,
    killSwitchVersion: killSwitch.version,
    controlledWriteBindings: [{ actionRef: "publish_result", resourceRef: "resource_campaign_uaos" }]
  });
  return {
    manifest: controlledManifest,
    actionRef: "publish_result",
    resourceRef: "resource_campaign_uaos",
    policy,
    budget,
    approvals: [approval],
    revocation,
    killSwitch
  };
}

const priorReceiptEnv = process.env.NEUROCLAW_P2_2_RECEIPT;

afterEach(async () => {
  if (priorReceiptEnv === undefined) delete process.env.NEUROCLAW_P2_2_RECEIPT;
  else process.env.NEUROCLAW_P2_2_RECEIPT = priorReceiptEnv;
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// §1 求交语义（声明 ∩ 宿主强制）
// ---------------------------------------------------------------------------

describe("求交语义 · 声明 ∩ 宿主强制", () => {
  it("读/写范围取交；simulationOnly 取「或」（只能收紧不能放宽）", () => {
    const live = manifest({
      simulationOnly: false,
      readScopes: ["r1", "r2"],
      writeScopes: ["w1", "w2"]
    });
    const effective = resolveEffectivePluginCapabilities(live, {
      requireSimulationOnly: false,
      allowedReadScopes: ["r2", "r3"],
      allowedWriteScopes: ["w2"]
    });
    expect(effective.readScopes).toEqual(["r2"]);
    expect(effective.writeScopes).toEqual(["w2"]);
    expect(effective.withheldReadScopes).toEqual(["r1"]);
    expect(effective.withheldWriteScopes).toEqual(["w1"]);
    expect(effective.simulationOnly).toBe(false);

    // 宿主要求 simulation ⇒ 收紧（即便清单声明 live）。
    const tightened = resolveEffectivePluginCapabilities(live, { requireSimulationOnly: true });
    expect(tightened.simulationOnly).toBe(true);

    // 清单声明 simulation ⇒ 宿主无法放宽。
    const declared = resolveEffectivePluginCapabilities(manifest({ simulationOnly: true }), {
      requireSimulationOnly: false
    });
    expect(declared.simulationOnly).toBe(true);
  });

  it("装载期空交集：宿主要求 simulation-only 而清单声明 live ⇒ 拒绝（默认策略）", () => {
    const error = (() => {
      try {
        assertPluginCapabilitiesGrantable(manifest({ simulationOnly: false }));
      } catch (caught) {
        return caught as PluginCapabilityError;
      }
      throw new Error("expected CAPABILITY_GRANT_EMPTY");
    })();
    expect(error).toBeInstanceOf(PluginCapabilityError);
    expect(error.code).toBe("CAPABILITY_GRANT_EMPTY");

    // 宿主显式放宽后通过，并返回有效能力。
    const effective = assertPluginCapabilitiesGrantable(manifest({ simulationOnly: false }), {
      requireSimulationOnly: false
    });
    expect(effective.simulationOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §2 能力句柄 · 调用边界拒绝码
// ---------------------------------------------------------------------------

describe("能力句柄 · 调用边界拒绝码", () => {
  it("读：未声明 → NOT_DECLARED；声明未授予 → NOT_GRANTED；声明+授予 → 放行", async () => {
    const handle = createPluginCapabilityHandle({
      manifest: manifest({ simulationOnly: false, readScopes: ["org:read"] }),
      policy: { requireSimulationOnly: false, allowedReadScopes: ["org:read"] }
    });
    expect(handle.read("org:read")).toMatchObject({ kind: "read", scope: "org:read" });

    const notDeclared = await captureCapabilityError(() => handle.read("content:read"));
    expect(notDeclared.code).toBe("CAPABILITY_READ_NOT_DECLARED");

    const narrowed = createPluginCapabilityHandle({
      manifest: manifest({ simulationOnly: false, readScopes: ["org:read"] }),
      policy: { requireSimulationOnly: false }
    });
    const notGranted = await captureCapabilityError(() => narrowed.read("org:read"));
    expect(notGranted.code).toBe("CAPABILITY_READ_NOT_GRANTED");
  });

  it("写：simulation-only 在调用边界先行阻断（即使已声明且已授予、证据有效）", async () => {
    const handle = createPluginCapabilityHandle({
      manifest: manifest({ simulationOnly: true, writeScopes: ["content:publish"] }),
      policy: { requireSimulationOnly: false, allowedWriteScopes: ["content:publish"] },
      authorizeControlledWrite: () => validControlledWriteEvidence()
    });
    const error = await captureCapabilityError(() =>
      handle.write({ scope: "content:publish", actionRef: "publish_result", resourceRef: "resource_campaign_uaos" })
    );
    expect(error.code).toBe("CAPABILITY_SIMULATION_ONLY_BLOCKED");
  });

  it("写：writeScopes 空 → NOT_DECLARED；声明未授予 → NOT_GRANTED", async () => {
    const empty = createPluginCapabilityHandle({
      manifest: manifest({ simulationOnly: false }),
      policy: { requireSimulationOnly: false }
    });
    const notDeclared = await captureCapabilityError(() =>
      empty.write({ scope: "content:publish", actionRef: "publish_result", resourceRef: "resource_campaign_uaos" })
    );
    expect(notDeclared.code).toBe("CAPABILITY_WRITE_NOT_DECLARED");

    const notGrantedHandle = createPluginCapabilityHandle({
      manifest: manifest({ simulationOnly: false, writeScopes: ["content:publish"] }),
      policy: { requireSimulationOnly: false }
    });
    const notGranted = await captureCapabilityError(() =>
      notGrantedHandle.write({
        scope: "content:publish",
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos"
      })
    );
    expect(notGranted.code).toBe("CAPABILITY_WRITE_NOT_GRANTED");
  });

  it("写：writeScopes 非空且已授予 ⇒ 必过授权链（无 resolver / 无证据 / 链拒绝）", async () => {
    const base = {
      manifest: manifest({ simulationOnly: false, writeScopes: ["content:publish"] }),
      policy: { requireSimulationOnly: false, allowedWriteScopes: ["content:publish"] }
    };
    const request = { scope: "content:publish", actionRef: "publish_result", resourceRef: "resource_campaign_uaos" };

    const noResolver = await captureCapabilityError(() =>
      createPluginCapabilityHandle(base).write(request)
    );
    expect(noResolver.code).toBe("CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED");
    expect(noResolver.detail.cause).toBe("no-resolver");

    const noEvidence = await captureCapabilityError(() =>
      createPluginCapabilityHandle({ ...base, authorizeControlledWrite: () => null }).write(request)
    );
    expect(noEvidence.code).toBe("CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED");
    expect(noEvidence.detail.cause).toBe("no-evidence");

    const chainRefused = await captureCapabilityError(() =>
      createPluginCapabilityHandle({
        ...base,
        authorizeControlledWrite: () => ({}) as unknown as ControlledWriteAuthorizationInput
      }).write(request)
    );
    expect(chainRefused.code).toBe("CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED");
    expect(typeof chainRefused.detail.cause).toBe("string");
    expect(String(chainRefused.detail.cause).length).toBeGreaterThan(0);
  });

  it("写：有效证据经真实 CONTROLLED_WRITE 链放行；注入接缝的拒绝按同码上抛", async () => {
    const evidence = validControlledWriteEvidence();
    const handle = createPluginCapabilityHandle({
      manifest: manifest({ simulationOnly: false, writeScopes: ["content:publish"] }),
      policy: { requireSimulationOnly: false, allowedWriteScopes: ["content:publish"] },
      authorizeControlledWrite: () => evidence
    });
    const grant = await handle.write({
      scope: "content:publish",
      actionRef: "publish_result",
      resourceRef: "resource_campaign_uaos"
    });
    expect(grant).toMatchObject({ kind: "write", scope: "content:publish", actionRef: "publish_result" });

    const stubbed = createPluginCapabilityHandle({
      manifest: manifest({ simulationOnly: false, writeScopes: ["content:publish"] }),
      policy: { requireSimulationOnly: false, allowedWriteScopes: ["content:publish"] },
      authorizeControlledWrite: () => evidence,
      assertControlledWrite: () => {
        throw new Error("stub chain denial");
      }
    });
    const error = await captureCapabilityError(() =>
      stubbed.write({ scope: "content:publish", actionRef: "publish_result", resourceRef: "resource_campaign_uaos" })
    );
    expect(error.code).toBe("CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED");
    expect(error.detail.cause).toBe("stub chain denial");
  });

  it("撤销：revoke 后任何调用被拒（HANDLE_REVOKED）；网络/文件系统桩有明确错误码", async () => {
    const handle = createPluginCapabilityHandle({
      manifest: manifest({ simulationOnly: false, readScopes: ["org:read"] }),
      policy: { requireSimulationOnly: false, allowedReadScopes: ["org:read"] }
    });
    handle.revoke();
    expect(handle.revoked).toBe(true);
    const revokedRead = await captureCapabilityError(() => handle.read("org:read"));
    expect(revokedRead.code).toBe("CAPABILITY_HANDLE_REVOKED");

    const active = createPluginCapabilityHandle({
      manifest: manifest({ simulationOnly: false }),
      policy: { requireSimulationOnly: false }
    });
    const network = await captureCapabilityError(() => active.network.request("https://example.invalid"));
    expect(network.code).toBe("CAPABILITY_NETWORK_NOT_GRANTED");
    const filesystem = await captureCapabilityError(() => active.filesystem.access("/etc/passwd"));
    expect(filesystem.code).toBe("CAPABILITY_FILESYSTEM_NOT_GRANTED");
  });
});

// ---------------------------------------------------------------------------
// §3 PluginHost · 能力授予门（装载前拒绝；句柄经钩子发放）
// ---------------------------------------------------------------------------

describe("PluginHost · 能力授予门与句柄发放", () => {
  it("默认策略（要求 simulation-only）：live 清单被拒于 import 之前", async () => {
    const dir = await makeDir("plugin-host-cap-gate-");
    await writeManifest(dir, "live.plugin.json", { pluginKey: "live_pack", simulationOnly: false });
    const { imports, importer } = spyImporter();
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["live_pack"],
      importer,
      ...silent
    });

    await host.init();

    expect(host.getEntry("live_pack")).toMatchObject({
      state: "rejected",
      enabled: false,
      importAttempted: false
    });
    expect(host.getEntry("live_pack")?.error).toContain("CAPABILITY_GRANT_EMPTY");
    expect(imports).toHaveLength(0);
  });

  it("显式策略放宽后：装载成功，钩子收到能力句柄（调用边界拒绝码 + disable 撤销）", async () => {
    const dir = await makeDir("plugin-host-cap-issue-");
    await writeManifest(dir, "live.plugin.json", {
      pluginKey: "live_pack",
      simulationOnly: false,
      readScopes: ["org:read"],
      writeScopes: ["content:publish"]
    });
    const observed: Array<{ op: string; ok?: boolean; code?: string }> = [];
    let issued: PluginHookContext["capabilities"] | null = null;
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["live_pack"],
      capabilityPolicy: {
        requireSimulationOnly: false,
        allowedReadScopes: ["org:read"],
        allowedWriteScopes: ["content:publish"]
      },
      importer: async () => ({
        async onLoad(ctx: PluginHookContext): Promise<void> {
          issued = ctx.capabilities;
          try {
            ctx.capabilities.read("org:read");
            observed.push({ op: "read", ok: true });
          } catch (error) {
            observed.push({ op: "read", code: (error as PluginCapabilityError).code });
          }
          try {
            await ctx.capabilities.write({
              scope: "content:publish",
              actionRef: "publish_result",
              resourceRef: "resource_campaign_uaos"
            });
            observed.push({ op: "write", ok: true });
          } catch (error) {
            observed.push({ op: "write", code: (error as PluginCapabilityError).code });
          }
        },
        async onEnable(): Promise<void> {}
      }),
      ...silent
    });

    const report = await host.init();
    expect(report).toMatchObject({ registered: 1, activated: 1 });
    expect(observed).toEqual([
      { op: "read", ok: true },
      { op: "write", code: "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED" }
    ]);

    await host.disable("live_pack");
    const handle = issued as unknown as { revoked: boolean; read: (scope: string) => unknown };
    expect(handle.revoked).toBe(true);
    const afterDisable = await captureCapabilityError(() => handle.read("org:read"));
    expect(afterDisable.code).toBe("CAPABILITY_HANDLE_REVOKED");
  });
});

// ---------------------------------------------------------------------------
// §4 运行时负向证据（真实动态 import · 金丝雀收据）
// ---------------------------------------------------------------------------

const PROBE_ENTRY = `import { writeFile } from "node:fs/promises";

async function attempt(results, op, fn) {
  try {
    const value = await fn();
    results.push({ op, ok: true, scope: value && value.scope ? value.scope : null });
  } catch (error) {
    results.push({
      op,
      ok: false,
      code: error && error.code ? error.code : null,
      message: String((error && error.message) || error)
    });
  }
}

export async function onLoad(ctx) {
  const results = [];
  await attempt(results, "write", () =>
    ctx.capabilities.write({
      scope: "content:publish",
      actionRef: "publish_result",
      resourceRef: "resource_campaign_uaos"
    })
  );
  await attempt(results, "read", () => ctx.capabilities.read("org:read"));
  await writeFile(process.env.NEUROCLAW_P2_2_RECEIPT, JSON.stringify(results));
}

export async function onEnable() {}
`;

type ReceiptEntry = { op: string; ok: boolean; code: string | null; scope?: string | null };

async function runProbe(
  manifestOverrides: Record<string, unknown>,
  policy: PluginCapabilityPolicy | undefined
): Promise<{ receipt: ReceiptEntry[]; entry: NonNullable<ReturnType<PluginHost["getEntry"]>> }> {
  const pluginsDir = await makeDir("plugin-host-runtime-");
  const receiptDir = await makeDir("plugin-host-runtime-receipt-");
  const receiptPath = path.join(receiptDir, "receipt.json");
  const pluginKey = String(manifestOverrides.pluginKey);
  await writeManifest(pluginsDir, `${pluginKey}.plugin.json`, manifestOverrides);
  await writeFile(path.join(pluginsDir, "entry.mjs"), PROBE_ENTRY);
  process.env.NEUROCLAW_P2_2_RECEIPT = receiptPath;

  const host = new PluginHost({
    hostApiVersion: DEFAULT_HOST_API_VERSION,
    pluginsDir,
    enabledPluginKeys: [pluginKey],
    capabilityPolicy: policy,
    ...silent
  });
  const report = await host.init();
  expect(report).toMatchObject({ discovered: 1, registered: 1, rejected: 0, activated: 1 });

  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as ReceiptEntry[];
  const entry = host.getEntry(pluginKey);
  if (!entry) throw new Error("plugin entry missing");
  return { receipt, entry };
}

describe("运行时负向证据 · 真实动态 import（调用边界强制）", () => {
  it("simulation-only 插件运行期写被拒（SIMULATION_ONLY_BLOCKED）、读未授予被拒，金丝雀收据落盘", async () => {
    const { receipt, entry } = await runProbe(
      { pluginKey: "sim_probe", simulationOnly: true, readScopes: ["org:read"] },
      undefined
    );
    expect(entry).toMatchObject({ state: "enabled", enabled: true, importAttempted: true });
    expect(receipt.map((item) => [item.op, item.ok, item.code])).toEqual([
      ["write", false, "CAPABILITY_SIMULATION_ONLY_BLOCKED"],
      ["read", false, "CAPABILITY_READ_NOT_GRANTED"]
    ]);
  });

  it("live 插件运行期写无 CONTROLLED_WRITE 证据被拒（NOT_AUTHORIZED），金丝雀收据落盘", async () => {
    const { receipt, entry } = await runProbe(
      { pluginKey: "live_probe", simulationOnly: false, writeScopes: ["content:publish"] },
      {
        requireSimulationOnly: false,
        allowedWriteScopes: ["content:publish"]
      }
    );
    expect(entry).toMatchObject({ state: "enabled", enabled: true, importAttempted: true });
    expect(receipt.map((item) => [item.op, item.ok, item.code])).toEqual([
      ["write", false, "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED"],
      ["read", false, "CAPABILITY_READ_NOT_DECLARED"]
    ]);
  });
});
