# 新项目接入指南 v0（simulation-only）

> 范围：仅 simulationOnly 契约、工具与文档。不接真实渠道账户、凭据、生产数据或外部写操作。
> 内核真源：`packages/shared/src/project-integration.ts`（schema + builder + 注册表 + 通用 adapter 输入生成）。

新项目接入 = 只加一份配置数据。内核不含任何项目名分支（`project-integration.test.ts`
有守卫测试），项目身份、Pack、Adapter、Workflow 全部由配置派生。

## 三步接入

### 第 1 步 · 生成骨架（一行命令）

```sh
cd p0-growth-v1
node scripts/onboard-project.mjs <projectKey> [--name "<显示名>"] [--type <projectTypeKey>] [--out <目录>]
```

- `projectKey`：小写 snake_case、以字母开头（2–64 字符），由内核 schema 校验。
- 默认生成到 `examples/<projectKey>/`，含 `project.integration.json` + `README.md`。
- 生成后脚本会立即调用校验命令；失败即非零退出，不会留下"看似可用"的骨架。

### 第 2 步 · 只改配置（5 个必填身份字段）

```json
{
  "projectKey": "demo_sandbox",
  "projectTypeKey": "synthetic_sandbox_demo",
  "packId": "pack_demo_sandbox_simulation",
  "adapterId": "adapter_demo_sandbox_simulation",
  "sourceSystem": "DEMO_SANDBOX_SIMULATION"
}
```

其余字段（lifecycleProfile、objectiveProfiles、workflowId、capabilityRefs、
evidenceRules、timeoutMs、retryPolicy、rateLimit……）均有 simulation-safe 默认值，
见 `simulationProjectIntegrationConfigSchema`。schema 为 `.strict()`：未知字段直接报错。

**零内核改动口径**：不允许为了新项目修改 `packages/shared/src/` 下的内核或契约代码；
新项目的一切差异都必须落在配置里。

### 第 3 步 · 校验 + 注册 + 生成模拟 Adapter 输入

校验（可对任意数量的配置文件执行）：

```sh
cd p0-growth-v1
node scripts/validate-integration-config.mjs <config.json> [more.json ...]
# 正式示例（仓库内置）：
node scripts/validate-integration-config.mjs packages/shared/examples/demo_sandbox.integration.json
```

应用侧注册（纯内存、无持久化/网络副作用）：

```ts
import { readFileSync } from "node:fs";
import {
  createSimulationIntegrationRegistry,
  buildSimulationAdapterInputs
} from "@neuroclaw/shared";

const config = JSON.parse(readFileSync("<config.json>", "utf8"));
const registry = createSimulationIntegrationRegistry();
const registration = registry.register(config);          // 重复注册 fail-closed
const adapterInputs = buildSimulationAdapterInputs({      // 通用入口，接受任意 projectKey→manifest
  [registration.projectKey]: registration.bundle.adapter
});
// registration.bundle.{project,pack,adapter,workflow} 均已通过一致性门禁
// registration.{packRegistryEntry,adapterRegistryEntry,adapterInput} 为注册记录
```

## 契约要点

| 关注点 | 真源 |
| --- | --- |
| 配置 schema（含默认值与 `.strict()`） | `simulationProjectIntegrationConfigSchema` |
| 单项目全量派生 + 一致性门禁 | `buildSimulationProjectIntegration` / `assertSimulationProjectIntegrationConsistency` |
| 注册记录（Pack + Adapter 条目） | `buildSimulationProjectIntegrationRegistration` |
| simulationOnly 硬门禁 | `assertSimulationOnlyAdapter` |
| 通用 adapter 输入（无固定项目清单） | `buildSimulationAdapterInputs` |
| Pack/Project/Workflow/Adapter 交叉一致性 | `assertProjectPackRegistryConsistency`（`universal-contracts.ts`） |

fail-closed 触发条件（任一即抛错）：`writeScopes` / `authRequirements` 非空、
`sideEffects !== ["none"]`、`adapterStatus !== "SANDBOXED"`、`packStatus !== "ACTIVE"`、
`budgetPolicy.mode !== "SIMULATION_ONLY"`、`scope.projectId` 与项目身份不一致、
受控写入绑定非空、未知配置字段。

"模拟运行"口径：校验通过后 adapter 输入 `readiness = READY`、`simulationOnly = true`、
`dryRunSupported = true`；这仅证明模拟契约可用，**不代表**真实项目输入、API、事件样本或
授权已具备（相关表述见 `toSimulationAdapterInput.nextAction`）。

## 验收清单

- [ ] 仅新增配置文件；`packages/shared/src/project-integration.ts` 零改动、无项目名。
- [ ] `node scripts/validate-integration-config.mjs <config.json>` 通过。
- [ ] 内置示例路径 `packages/shared/examples/demo_sandbox.integration.json` 通过。
- [ ] fail-closed 抽查：写入意图（`writeScopes`）、凭据（`authRequirements`）、
      外部副作用（`sideEffects`）、`budgetPolicy.mode: "LIVE"` 均被拒绝。
- [ ] simulationOnly 抽查：`SANDBOXED`、`inputSchema.mode = "SIMULATION"`、
      `writeScopes = []`、`controlledWriteBindings = []`。
- [ ] 证据口径：本地校验输出记为 E1；不写成 E3，不宣称真实接入已就绪。

## Registry 只读查询

`createSimulationIntegrationRegistry()` 只提供 `register` / `get` / `list` 三个面：
`get(projectKey)` 与 `list()` 即只读查询；注册项一经写入即不可变，**无 update/delete 面（N/A）**，
变更需换 `packId@version` / `adapterId@version` 后重新注册。
