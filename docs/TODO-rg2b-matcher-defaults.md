# TODO · RG-2b：role-grid → D5 matcher 缺省字段（待业务定义，不发明）

- 背景：I-035 RG-2b 接线（`packages/agent-workforce-contract/src/executability-bridge.ts`）复用 shared D5 matcher（`packages/shared/src/capability-matching.ts`，E3 实测）。
- 事实：`AgentProfile` 的 `skills/tools` **没有** `weight / layer / chainSegment / minEvidence` 的对应来源字段（GM 裁定：缺省 + 文档标注，不发明业务语义）。下表为待补清单；缺省值均为**保守取向**。
- 证据：`.artifacts/i035-role-grid/rg2b/evidence.md`（E3 实测，2026-09-27）。
- 边界：本文件仅登记缺省与待办，不改变任何判定逻辑；字段来源定义待 GM/业务裁决。

| 字段 | 缺省值 | 保守理由（一行） | 判定影响 | TODO / 归属 |
|---|---|---|---|---|
| `weight` | `MUST` | 提案 §二-5/6 上岗判据为“每个 capabilityRef 须 COVERED”；缺失即 tier C 拦截，不静默降级 | 拦截优先（tier C 偏多） | 业务为每 ref 标注可降级者（SHOULD/NICE）后改来源字段；RG-2 后续小步 |
| `layer` | `L0` | D5 判定不读取 layer（仅元数据，`capability-matching.ts:220-320`）；取枚举下界占位 | 无 | 能力分层（L0–L8）定义后填充 |
| `chainSegment` | `execute` | D5 仅对 `deliver` 加通道就绪检查（`:276-294`）；无来源时不发明投递语义 | deliver 通道检查暂不触发 | 投递类工具（notification/publish）需显式段映射；与 TODO-3 联动 |
| `minEvidence` | `E1` | 取 D5 证据地板（E0 永不可 COVERED，`:166-175`）；不发明更高门槛 | 与地板一致（当前清单 AVAILABLE 全 E3，无实际差异） | 若业务要求 ≥E2 能力证据，需来源字段 |
| `requiresRealSideEffect` | tool.scopes 含 `write` ⇒ `true`，否则 `false` | 来源字段直映射（提案 §二-7 写范围语义），非缺省 | 正确触发 D5 rule 5 | 无 |
| `simulationOnly` | 仅 `capability_growth_simulation` = `true`（E3 依据：`universal-contracts.ts:2942/:2949` `budgetPolicy: SIMULATION_ONLY`、`:2994` “simulation-only, read-only”） | 代码面构造即 simulation-only；**不以命名推测**其他 ref | 正确触发 D5 rule 5（write + simulation ⇒ PARTIAL） | 新 simulation provider 入库时登记白名单（或清单 schema 增字段）；RG-2a 后续 |
| `requires`（依赖） | `[]`（空） | 清单 schema 无依赖字段；D5 依赖“已解析布尔” | 无法表达版本/依赖阻塞（fail-closed 由 P-1 承担） | P-1 semver 注册表接入后提供 |
| `channels`（通道） | `[]`（空） | 清单 schema 无通道字段 | `deliver` 段检查无输入 | 渠道账号状态源（AW-1 TODO-3 / L2）落地后接入 |

- 建议归属：RG-2b 后续小步 / RG-3b `canAgentTakeDuty` 前置；清单 schema 扩展需与 RG-2a 写集协调。
- 关联：`.artifacts/i035-role-grid/rg2/evidence.md:39`（RG-2b 未决项）、`aw1/CAPABILITIES.md:137`（RG-2b 验收）、`aw1/CAPABILITIES.md:156`（TODO-8）。
