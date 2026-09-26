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
├── db/               Drizzle ORM + PostgreSQL/PGlite,版本化迁移与 pgvector
│                     (workspace/run/approval/memory/audit/job 等表),启动时幂等迁移
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
| `DATABASE_URL` | PostgreSQL 连接（**生产必须配置**）；本地可用 `file:` 持久化 PGlite，测试用 `:memory:` | `:memory:` |
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

0. **生产安全门(Round J)**:`NODE_ENV=production` 时,若 `DATABASE_URL` 未设/为 `:memory:`,或 `NEUROCLAW_API_KEYS` 为空,**服务器将拒绝启动**(fail-closed),不再依赖人工检查。
1. **持久化**:生产必须设置 PostgreSQL `DATABASE_URL`；`file:` PGlite 仅用于本地持久化开发/演练，`:memory:` 仅用于测试。
2. **认证**:必须配置强随机 `NEUROCLAW_API_KEYS`。⚠️ 未配置时系统进入开发模式——所有请求自动获得 admin 权限,绝不可用于生产。
3. **前端托管**:`npm run build` 后由 control-plane 直接服务 `apps/web/dist`;可用 `NEUROCLAW_STATIC_DIR` 覆盖路径。
4. **健康与就绪**:`GET /health` 只表示进程存活；由 `npm start` 启动的运行时中，`GET /ready` 检查数据库、最新迁移 `0010_ac6_attempt_replay_audit`、核心表和 durable job-loop 心跳，未就绪返回 503 `NOT_READY`。队列/Worker、OTLP 和外部投递仍需 AF-0 单独验收。
5. **优雅停机**:SIGINT/SIGTERM 触发 HTTP drain(10s 超时)→ 停 worker → 关库 → OTel flush。
6. **可观测性**:设置 `OTEL_EXPORTER_OTLP_ENDPOINT` 接入 Honeycomb/Tempo/Jaeger;关键 span 已埋点(createWorkspace/createRun/updateApproval/enqueue/processClaimed)。
7. **CI**:GitHub Actions(`.github/workflows/ci.yml`)在 push/PR 运行 typecheck + test + build + e2e;另含 `npm audit --audit-level=high`、release manifest 完整性断言(`npm run assert:release`)与产物断言(`npm run assert:bundle`,禁止 dist 含服务端密钥引用)。`npm run build` 会在 `apps/web/dist/release-manifest.json` 写入包版本、锁文件 SHA-256、资源大小/hash 和确定性 buildId；manifest 不含凭据。

## Round J — R1-C 技术 P0 清障(2026-08 审计落地)

- **异步执行解耦(audit P0-C1)**:`POST /api/runs` 返回 **202**,Run 以 queued 状态落库并入队;durable job loop(750ms tick)后台 claim→execute→persist;`recoverStaleJobs` 每 60s 自动回收卡死任务。审批恢复同样走队列。
- **多租户 ACL(audit P0-C4)**:新增 `workspace_members` 表;创建 workspace 时播种 owner=admin;全部 workspace-scoped 路由与 ID 寻址资源(artifact/knowledge/memory/approval/clone)强制成员校验(403 WORKSPACE_FORBIDDEN);无成员的存量 workspace 保留 bootstrap 访问。attachKnowledge 改为按 workspace 过滤(P0-C5)。
- **租户索引(audit P1-10)**:runs/jobs/schedules/memory/knowledge/artifacts/approvals/members 共 9 组索引 DDL;存量库自动补列(runs.tokens_used/cost_usd)。
- **LLM 加固与计量(audit P1-11)**:generateObject 统一 maxRetries+abortSignal 超时;usage 监听逐 Run 汇总 token 写入 runs.tokens_used,可选 `NEUROCLAW_AI_COST_USD_PER_1M_TOKENS` 折算 cost_usd。
- **OTel 真实 SDK(audit P0-可观测)**:@opentelemetry/sdk-node 2.x 四件套已入库,配置 OTLP endpoint 即生效(此前动态 import 必然回落 Noop)。
- **前端止血(audit P0-D1/D3、P0-E2)**:移除浏览器端 process.env 引用(CI 产物断言兜底);ErrorBoundary 防白屏;color-scheme=light;审批 reviewerId 取本地操作员身份(lib/operator);运行状态中文映射(lib/statusLabels,zh-CN 显示「待审批/执行中…」)。
- **契约统一(audit P0-D2)**:web 类型改为从 `@neuroclaw/shared` re-export(vite alias 直连 src),消除手抄漂移。

## Round K — R1 商业化骨架 + 北星仪表(2026-08 审计落地)

- **订阅与配额(audit P0-B3)**:`subscriptions` + `usage_counters`(原子 upsert)表;workspace 首次使用自动开通 14 天免绑卡试用期(Starter 档 30 Runs/月);`POST /api/runs` 前强制配额门,超额返回 **402 QUOTA_EXCEEDED**;`GET /api/billing/summary`、`POST /api/billing/plan` 上线(真实支付网关仍为 reserved lane,本层承载手动开通语义)。plan 五档:`starter|growth(legacy=Team)|team|business|enterprise`,配额 30/100/100/500/不限。
- **北星指标(audit P1-07)**:`product_events` 表 + 关键路径埋点(`workspace.created / run.created / run.completed / approval.decided / day7_first_result / subscription.plan_changed`);`GET /api/analytics/northstar` 输出激活率(workspace→首 run)、**Day7 达成率**(建 workspace 7 天内首个完成结果)、事件趋势;全局视图仅 admin,workspace 视图限成员。
- **并发硬化**:usage 计数改 `ON CONFLICT DO UPDATE` 单语句自增(唯一索引),消除并行创建下的读-改-写竞态。

治理侧同步交付(见 neuroclaw-final-operating-system):
- `deliverables/53-brand-narrative-charter.md` —— 品牌正典:核心叙事母本、「增长员工」品类绑定、承诺诚实化+兜底条款、术语统一令。
- `deliverables/54-roadmap-constitution.md` —— 路线图宪法:P1=Crew 裁决(Venture OS 转内部 Labs lane)、定价归一四档、14 天免绑卡基线、reserved lane 解锁条件、supremacy 条款。

## Round L — UX 轮(2026-08 审计落地)

- **导航 IA 收敛(audit P0-E5)**:顶栏 14 个平铺入口收敛为 3 组下拉(Growth=工作台/定时/分析/套餐 · Crew=能力广场/团队/工作流 · 资产库=品牌画像/知识库/产出物/历史/记忆)+ 常驻收件箱铃铛(角标)+ 全局启动钮;移动端汉堡抽屉;Escape/外点关闭,aria-haspopup/expanded。
- **「我的7天计划」横幅(audit P0-E1)**:工作台顶部 Day N 进度条 + 今日待办(8 天里程碑静态 v1,对齐品牌正典诚实版承诺);workspace.createdAt 持久化于 onboarding,缺省回退最早 run 时间。
- **审批卡四要素(audit P1-4/P0-E2)**:`ApprovalCard` 统一 RunStatus/Inbox 两页——①全文预览(InputSummaryStrip,Inbox 懒加载)②目标渠道徽章③人话版风险原因+系统判定原文④批准二次确认 Modal+拒绝原因必选(radio)。
- **真实撤回窗口**:新增 `POST /api/runs/:id/cancel`(queued/waiting_approval/running→cancelled)+ job loop 对已取消 Run 的跳过与迟到结果的防复活守卫;UI 在执行全程显示「撤销执行」。
- **Billing/NorthStar 前端(Round K 展示层)**:`/billing` 页(trial 徽章、配额仪表、四档卡片切换、growth 别名提示);分析页内嵌北星区块(激活率/Day7 达成率/事件 chips)。

## Round N — R2-A1 Spike · Postgres 方言移植(ADR-56 落地)

- **方言切换**:packages/db 全面迁移 `sqliteTable→pgTable`(16 表);时间列暂留 TEXT(ISO-8601 UTC 字典序=时序,隔离方言风险;timestamptz 留待 R2-A2);memory 布尔列改原生 boolean。
- **双运行时驱动**:`postgres://`→node-postgres Pool(生产/CI);`:memory:`→PGlite 内嵌真实 PG 内核(测试);`file:./path`→PGlite 持久目录(**本地免 Docker**);libsql 已移除。
- **隐性缺陷修复(N-3)**:`ControlPlaneService.create` 此前硬编码 createInMemoryDb——配置的 DATABASE_URL 从未生效;现已默认走 createDb() 读环境变量。
- **rowid×8 清除**:全部 `ORDER BY rowid DESC` 改为业务时间戳 DESC(runs 加 id 次级键);Postgres 无 rowid,此为规范承诺的必清项。
- **测试基建**:vitest 单 fork 串行(PGlite 每进程一次性 WASM/JIT 预热 ~10s,并发 worker 会饱和 CPU 造成超时抖动);79 例全绿于真实 PG 方言,套件 ~147s。
- **CI**:build 与 e2e 双 job 注入 `pgvector/pgvector:pg16` 服务容器(DATABASE_URL 直连),为 R2-A3 向量记忆预埋镜像;本地提供 docker-compose.dev.yml。
- **验收**:typecheck ✓ / 79 单测 ✓ / build+assert ✓ / audit=0 ✓ / 生产模式 E2E 11 passed ✓

## Round O — R2-A2/A3 · 迁移基线 / timestamptz / RLS 基线 / 向量记忆

- **版本化 SQL 迁移器**:`schema_migrations` 表 + 三份迁移(0001 全量基线/timestamptz 化 · 0002 RLS 策略 · 0003 pgvector);**不引回 drizzle-kit**(规避 Round I 安全链),迁移即评审工件;每语句独立执行,node-postgres 与 PGlite 双兼容。
- **timestamptz 物理化**:全部时间列转 `TIMESTAMPTZ`;应用层保持 ISO-8601 UTC 字符串契约(node-postgres 类型解析器归一化,int8 计数同步修复);drizzle schema 映射决策记录于 schema.ts 头注。
- **RLS 策略基线**:9 张租户表 ENABLE + workspace 隔离 POLICY(`current_setting('app.workspace_id')`);owner-bypass 语义下零行为变更,FORCE 激活清单见 ADR-56 附录 B。
- **向量记忆(R2-A3)**:`knowledge_entries.embedding vector(1536)` + HNSW(cosine);`embed_knowledge` durable job(独立 `NEUROCLAW_EMBEDDINGS_API_KEY`,无凭据零入队、失败走重试);`attachKnowledge` 无显式选择时**语义自动召回** top-k + 时间衰减重排(τ=30d),降级链:向量→最近条目。
- **稳定性**:server 启动预热核心表查询路径(PGlite 首次执行一次性 JIT 税不再冲击首请求);embed 任务在 job loop 中绕过 runs 行查找(knowledgeId ≠ runId)。

## Round P — R2-B 前端换骨(审计 E4 落地)

- **TanStack Query 数据层**:高价值页面迁移完成——RunStatus(run+approvals)/Inbox/Layout 收件箱角标/Home/History/Analytics/Billing;轮询统一为 `refetchInterval` + `refetchIntervalInBackground:false`(后台标签页零流量);竞态由 Query 取消语义消除;审批/撤销走 mutation+invalidate。其余静态页增量迁移待后续。
- **路由懒加载**:全部 20 个页面 React.lazy+Suspense 骨架;**入口包 385KB→269KB(gzip 114.8→85.4KB)**,页面按需分片 26 chunks。
- **运行事件流(SSE,Round Q 已修复并默认开启)**:新端点 `GET /api/runs/:id/events`(400ms 差量侦测、终态即关);前端 `useRunEventStream` 主链路实时推送,轮询 1.2s 仅作降级兜底。可用 `VITE_RUN_SSE=0` 关闭。
- **主链路实时性现状**:SSE 推送为主(仅活动态连接),轮询降级兜底。

## Round Q — SSE 根因修复 + 实时链路默认开启

- **误诊纠正**:Round P 曾将 UI 不更新归因于"@hono/node-server 流式缓冲"——经最小复现+中间件隔离实验证伪。**真因:审计中间件对 `/events` 流式响应执行 `c.res.clone().json()`,在流未关闭前永久阻塞**(该端点落入通用 `method.api` 审计分类)。
- **修复**:审计中间件跳过 `*/events` 流式端点;非 JSON 响应不再克隆;保留 JSON 克隆(此时已安全)。
- **验证**:curl 实时捕获 `open→run(queued)→run(waiting_approval)` 帧序列后终态关流;生产模式 E2E 双 worker 11 passed——审批全流程跑在真实推送上。
- **方法学教训入库**:性能/流式问题诊断必须先确认服务就绪态与进程唯一性,再归因组件(本轮曾因"端口残留进程+预热窗口"两次误判)。

## Round R — 组件测试金字塔基建(审计 E4 P1-6 落地)

- **测试栈**:@testing-library/react + jest-dom(vitest 匹配器) + user-event v14 + jsdom(文件级 `@vitest-environment` 声明,node 套件零影响)+ @vitest/coverage-v8;setupFiles 统一 cleanup。
- **18 个新用例/6 文件**:ErrorBoundary 兜底与恢复按钮 · Modal 开关/Esc/backdrop/确认 · SevenDayPlanBanner 三态(未开始/Day N/已完成+进度条 a11y) · ApprovalCard 四信任要素/批准二次确认/**拒绝原因必选传参**/未知动作降级 · statusLabels 双语契约 · operator 身份持久化。
- **覆盖率基线**(web 层,`npm run test:coverage`):Lines **9.39%** / Branches 48.52%;新增文件 ErrorBoundary 100%、Banner 97.7%。阈值挂 CI 待迁移存量页面测试后启用(棘轮策略,记录于任务卡)。
- **类型解析修正**:web tsconfig 改 `moduleResolution: bundler`(Vite 应用正确语义),解决 user-event d.ts 在 NodeNext 下 default 导出形状丢失问题。

## 当前状态与边界

- Round A–G 已完成:2026 前沿栈 Rebase(Turborepo/Hono/Zod/Drizzle/AI SDK/MCP/Playwright/OTel)、API 加固、真实 AI、前端升级、持久化任务系统、可观测性、CI、文档、外部投递通道(webhook/SMTP)与指标感知复盘。
- 有意延期(不进 P0):真实 OIDC 第三方校验、自定义角色/ABAC、分布式 worker 扩容、支付/Marketplace/Web4。
- 渠道连接器(公众号/小红书/企微)原生 API 未接入;当前通过 `NEUROCLAW_DELIVERY_WEBHOOK_URL` 与外部渠道系统交接,拿到客户账号后可替换为原生 connector。
