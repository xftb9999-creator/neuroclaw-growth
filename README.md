# NeuroClaw Growth (P0)

NeuroClaw Growth 是面向中小微企业(SMB)的增长员工系统。首发承诺:**7 天内跑出第一轮可量化的增长结果**。

首发仅包含三个岗位化场景包:

| 场景包 | 岗位 | 输出 | 审批 |
|--------|------|------|------|
| Content Acquisition | 内容员工 | 内容角度 + 渠道建议 | 无 |
| Private Conversion | 转化员工 | 转化文案 + 审批预览 | preview 发送强制人工审批 |
| Weekly Review | 复盘员工 | 复盘总结 + 下一步行动 | 无 |

任何新功能必须映射到以下至少一个指标,否则不进入 P0 范围:
7 天结果达成率 / 首次付费转化率 / 30 天续费率 / 输出一致性 / 执行稳定性。

## 技术架构

Turborepo monorepo(TypeScript strict + ESM):

```
apps/
├── control-plane/    Hono API + Zod 校验(zValidator) + API Key 认证(admin/viewer)
│                     + RBAC + 审计日志 + streamSSE(/api/ai/stream) + 静态托管 web/dist
├── runtime-worker/   Run 编排引擎:策略预检 → 模板动作流水线 → 审批门 → 结果聚合
├── temporal-worker/  DurableJobQueue:enqueue → claim → process → 指数退避重试
│                     → recoverStaleJobs() 崩溃恢复(jobs/job_attempts 表)
└── web/              React 19 + Tailwind v4 + SSE 流式 UI(7 页面用户旅程)

packages/
├── shared/           Zod schema 单一真相源(z.infer 派生类型)
├── templates/        3 个 P0 场景包契约(v2.0.0):输入/输出字段 + 审批规则
├── agent-core/       Vercel AI SDK(generateObject 结构化输出)
│                     OpenAI / Anthropic 自动探测;无 key 时 mock fallback
├── tooling-mcp/      官方 MCP SDK 客端(stdio / SSE / StreamableHTTP 三通道)
├── operator-browser/ Playwright 真实浏览器抽取(extract / executeActions)
├── db/               Drizzle ORM + LibSQL,7 张表(workspaces/runs/approvals/
│                     memory/audit/jobs/job_attempts),启动时幂等建表
├── policy/           动作级策略评估(deny / require_approval / degrade / allow)
├── memory/           产品级长期记忆(CRUD + pin/suppress)
└── observability/    OpenTelemetry SDK(可选激活)+ TraceLog + span 追踪
```

### 执行链路

```
Web → POST /api/runs → control-plane(校验/认证/审计)→ runtime-worker
  → evaluateRunPolicy 预检 → 逐动作:browser(MCP)/mcp(LLM)/notification
  → 高危动作(notification_send_preview)挂起 waiting_approval → 人工批准后恢复
  → 输出按模板 outputContract 聚合 → completed → 记忆沉淀
```

## 快速开始

要求 Node.js ≥ 20(`.nvmrc` 锁定版本)。

```bash
npm install
npm run build        # tsc -b + vite build
npm test             # vitest 全量单测
npm start            # 启动 control-plane(默认 http://0.0.0.0:8787)
npm run dev          # turbo 开发模式(web: 4173,proxy /api → 8787)
npm run test:e2e     # Playwright E2E
```

环境变量见 `.env.example`。最小可运行集(开发模式,无外部依赖):

```bash
NEUROCLAW_API_KEYS=dev-admin-key:founder:admin npm start
```

## 关键环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `DATABASE_URL` | LibSQL 连接(`file:` 本地文件或 `libsql://` Turso)。**生产必须配置** | `:memory:` |
| `DATABASE_AUTH_TOKEN` | Turso 认证令牌 | - |
| `PORT` / `HOST` | HTTP 监听 | `8787` / `0.0.0.0` |
| `NEUROCLAW_API_KEYS` | `key:user:role` 逗号分隔,角色 admin/operator/viewer | **未配置 = 开发模式(全部请求自动视为 admin)** ⚠️ 生产必须配置 |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | 真实 LLM 能力开关(二选一生效) | 无 = mock |
| `NEUROCLAW_AI_MODEL` | 模型覆盖 | `gpt-4o` / `claude-sonnet-4` |
| `NEUROCLAW_MCP_SERVERS` | MCP server 配置(JSON 数组) | 无 = 直连 LLM |
| `NEUROCLAW_DELIVERY_WEBHOOK_URL` | 审批后投递 webhook(POST JSON),外部系统承接渠道分发 | 未设 = 跳过 |
| `NEUROCLAW_SMTP_URL` 或 `NEUROCLAW_SMTP_HOST/PORT/USER/PASS/SECURE` | SMTP 邮件投递(需安装 nodemailer;run input 需带 recipientEmail) | 未设 = 预览模式 |

**审批后投递策略**(private_conversion 的 preview-send 步骤):`webhook → SMTP(需 recipientEmail)→ preview fallback`;外部通道失败会返回 failed 结果,由 durable job 层按指数退避重试。

**指标感知复盘**:weekly_review 支持可选 `metricsSummary`(字符串摘要)与结构化 `metrics` 数组(`{ name, value, delta? }`,API passthrough),复盘 prompt 会融合真实指标生成更精准的行动建议。
| `NEUROCLAW_BROWSER_DISABLED` | `1` 禁用真实浏览器抽取 | 启用 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP endpoint,设置即激活 OTel | 未设 = 内存 trace |

## 生产部署要点

1. **持久化**:必须设置 `DATABASE_URL`(本地文件或 Turso);默认 `:memory:` 仅用于开发测试。
2. **认证**:必须配置强随机 `NEUROCLAW_API_KEYS`。⚠️ 未配置时系统进入开发模式——所有请求自动获得 admin 权限,绝不可用于生产。
3. **前端托管**:`npm run build` 后由 control-plane 直接服务 `apps/web/dist`;可用 `NEUROCLAW_STATIC_DIR` 覆盖路径。
4. **优雅停机**:SIGINT/SIGTERM 触发 HTTP drain(10s 超时)→ 停 worker → 关库 → OTel flush。
5. **可观测性**:设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 接入 Honeycomb/Tempo/Jaeger;关键 span 已埋点(createWorkspace/createRun/updateApproval/enqueue/processClaimed)。
6. **CI**:GitHub Actions(`.github/workflows/ci.yml`)在 push/PR 运行 typecheck + test + build + e2e。

## 当前状态与边界

- Round A–G 已完成:2026 前沿栈 Rebase(Turborepo/Hono/Zod/Drizzle/AI SDK/MCP/Playwright/OTel)、API 加固、真实 AI、前端升级、持久化任务系统、可观测性、CI、文档、外部投递通道(webhook/SMTP)与指标感知复盘。
- 有意延期(不进 P0):真实 OIDC 第三方校验、自定义角色/ABAC、分布式 worker 扩容、支付/Marketplace/Web4。
- 渠道连接器(公众号/小红书/企微)原生 API 未接入;当前通过 `NEUROCLAW_DELIVERY_WEBHOOK_URL` 与外部渠道系统交接,拿到客户账号后可替换为原生 connector。
