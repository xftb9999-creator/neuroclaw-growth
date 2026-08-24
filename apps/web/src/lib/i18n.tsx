import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode
} from "react";

export type Locale = "zh-CN" | "en-US";

const LOCALE_STORAGE_KEY = "neuroclaw.locale";
const EMBED_PARAM = "embed";

type Dictionary = Record<string, string>;

const zhCN: Dictionary = {
  "common.appName": "NeuroClaw Growth",
  "common.tagline": "7 天跑出第一轮增长结果",
  "common.nav.home": "工作台",
  "common.nav.analytics": "分析",
  "common.nav.templates": "模板",
  "common.nav.history": "历史",
  "common.nav.memory": "记忆",
  "common.nav.profile": "品牌画像",
  "common.nav.agents": "能力广场",
  "common.nav.library": "产出物",
  "common.nav.knowledge": "知识库",
  "common.nav.team": "团队",
  "common.nav.inbox": "收件箱",
  "common.nav.schedule": "定时",
  "common.nav.workspace": "工作区",
  "common.language": "语言",
  "common.loading": "加载中…",

  "home.title": "增长工作台",
  "home.subtitle": "一句话启动 AI 员工，成果自动沉淀为可复用资产。",
  "home.launch.placeholder": "例如：给母婴店写一篇开业小红书笔记…",
  "home.launch.button": "启动",
  "home.launch.hint": "支持中文/英文，自动路由到对应员工",
  "home.stat.runs": "累计运行",
  "home.stat.completed": "已完成产出",
  "home.stat.memory": "记忆资产",
  "home.stat.pending": "待审批",
  "home.recent": "最近成果",
  "home.recentEmpty.title": "还没有成果卡片",
  "home.recentEmpty.body": "用上方输入条或从模板开始你的第一次运行。",
  "home.quick.templates": "浏览全部模板",
  "home.greeting.morning": "早上好",
  "home.greeting.afternoon": "下午好",
  "home.greeting.evening": "晚上好",
  "home.suggestion.content": "今天试试让内容员工产出 3 个新角度",
  "home.suggestion.review": "周末快到了,让复盘员工总结本周表现",

  "profile.title": "品牌画像",
  "profile.subtitle": "AI 员工从这里理解你的业务——越使用越精准。",
  "profile.positioning": "业务定位",
  "profile.audience": "客群画像",
  "profile.channels": "渠道偏好",
  "profile.tone": "品牌语调（本地草稿）",
  "profile.tonePlaceholder": "例：专业但亲切,多用emoji,避免夸张承诺…",
  "profile.toneSave": "保存草稿",
  "profile.toneSaved": "已保存（仅保存在本机浏览器）",
  "profile.fromRuns": "来自运行输入的沉淀",
  "profile.pinned": "置顶记忆",
  "profile.empty": "暂无数据,先去跑几次任务吧",
  "profile.manageMemory": "管理记忆",

  "render.copy": "复制",
  "render.copied": "已复制 ✓",
  "render.rawToggle": "查看原始数据",
  "render.rawHide": "收起原始数据",
  "render.noteTitleScore": "标题力",
  "render.hashtags": "推荐话题",
  "render.channels": "适配渠道",
  "render.anglePrefix": "角度",
  "render.imageIdea": "配图建议",
  "render.chatCaption": "企微私聊预览",
  "render.approvalReady": "审批预览已就绪,发送前需人工批准",
  "render.actions": "下一步行动清单",
  "render.reviewSummary": "本周复盘结论",
  "render.checkAll": "全部完成",

  "launch.title": "启动增长任务",
  "launch.subtitle": "说出目标,点几个选项,AI 员工自动完成剩下的。",
  "launch.welcome": "告诉我你的目标,比如「给母婴店做开业获客」,我来安排链路。",
  "launch.ack.content_acquisition": "收到!内容员工已就位。先确认两件事,马上开工:",
  "launch.ack.private_conversion": "收到!转化员工已就位。先确认两件事,马上开工:",
  "launch.ack.weekly_review": "收到!复盘员工已就位。先确认两件事,马上开工:",
  "launch.ask.audience": "这次主要面向哪类客群?",
  "launch.ask.channels": "重点投放到哪些渠道?(可多选)",
  "launch.ask.product": "想要什么产物?",
  "launch.ask.confirm": "确认无误就点下面按钮,链路自动执行:",
  "launch.confirmChoice": "下一步",
  "launch.restart": "重新开始",

  "pipeline.preflight": "策略预检",
  "pipeline.extract": "数据采集 / 浏览抽取",
  "pipeline.generate": "AI 内容生成",
  "pipeline.approval": "人工审批门",
  "pipeline.deliver": "交付与沉淀",

  "agents.title": "能力广场",
  "agents.subtitle": "你的智能体阵容与可调用的外部工具(MCP 插件)。",
  "agents.builtin": "内置员工",
  "agents.custom": "定制智能体",
  "agents.create": "✦ 创建智能体",
  "agents.nameCol": "名称",
  "agents.engineCol": "基座引擎",
  "agents.statusCol": "状态",
  "agents.actionsCol": "操作",
  "agents.enable": "启用",
  "agents.disable": "停用",
  "agents.launch": "启动",
  "agents.mcpTitle": "MCP 插件服务器",
  "agents.mcpEmpty": "未配置 MCP 服务器。在 .env 中设置 NEUROCLAW_MCP_SERVERS 即可接入全球插件生态。",
  "agents.toolsCount": "工具数",
  "agents.connected": "已连接",
  "agents.disconnected": "未连接",

  "builder.title": "创建智能体",
  "builder.subtitle": "全程点选,一分钟生成你的专属增长员工。",
  "builder.step.base": "选择基座能力",
  "builder.base.content_acquisition.d": "产出内容角度、渠道建议、话题标签",
  "builder.base.private_conversion.d": "生成转化话术,带审批门与投递链路",
  "builder.base.weekly_review.d": "把指标变成复盘结论和行动清单",
  "builder.step.focus": "专长方向(可多选)",
  "builder.step.style": "输出风格",
  "builder.style.structured": "结构化卡片",
  "builder.style.checklist": "行动清单",
  "builder.style.copy": "成稿文案",
  "builder.step.toolbind": "绑定 MCP 工具(可选)",
  "builder.toolbind.none": "暂不绑定工具",
  "builder.step.identity": "命名你的智能体",
  "builder.field.name": "智能体名称",
  "builder.field.slug": "标识 slug(小写字母/数字/下划线)",
  "builder.confirm": "创建智能体",
  "builder.creating": "创建中…",
  "builder.done": "已加入能力广场 ✓",

  "library.title": "产出物库",
  "library.subtitle": "每次运行的成果自动沉淀为可复用资产。",
  "library.filter.all": "全部",
  "library.filter.note": "图文笔记",
  "library.filter.copy": "转化文案",
  "library.filter.report": "复盘报告",
  "library.open": "查看运行",
  "library.empty": "还没有产出物,先去跑几次任务吧",
  "library.download": "下载 JSON",
  "library.deleted": "已删除",

  "knowledge.title": "知识库",
  "knowledge.subtitle": "沉淀品牌事实与打法,智能体生成时自动引用。",
  "knowledge.addTitle": "标题",
  "knowledge.addContent": "内容(事实/打法/偏好)",
  "knowledge.addTags": "标签(逗号分隔,可选)",
  "knowledge.add": "添加条目",
  "knowledge.empty": "暂无条目。建议先添加:品牌介绍、目标客群、语气规范、历史爆款。",
  "knowledge.delete": "删除",
  "knowledge.attachedHint": "启动对话中可勾选条目注入提示词",

  "team.title": "智能体团队",
  "team.subtitle": "一次目标,多个员工接力:产出自动流入下一环。",
  "team.playbook.sprint.name": "开业增长冲刺",
  "team.playbook.sprint.desc": "内容员工出选题 → 转化员工写私聊话术 → 复盘员工给行动清单",
  "team.playbook.contentReview.name": "内容周循环",
  "team.playbook.contentReview.desc": "内容员工批量出角度 → 复盘员工评估优先级",
  "team.goalLabel": "本次团队目标",
  "team.audienceLabel": "目标客群",
  "team.start": "🚀 启动团队接力",
  "team.running": "执行中…",
  "team.step": "环节",
  "team.done": "完成",
  "team.failed": "失败",

  "inbox.title": "审批收件箱",
  "inbox.subtitle": "所有待人工审批的外发动作集中在这里处理。",
  "inbox.emptyTitle": "收件箱清空 ✓",
  "inbox.emptyBody": "有新的高危外发动作时,会第一时间出现在这里。",
  "sched.title": "定时任务",
  "sched.subtitle": "让 AI 员工按节奏自动运行——比如每天早上出选题。",
  "sched.frequency": "执行频率",
  "sched.freq.demo": "每 5 分钟(演示)",
  "sched.freq.daily": "每天",
  "sched.freq.weekly": "每周",
  "sched.add": "创建定时任务",
  "sched.empty": "还没有定时任务。建议:每周一自动跑一次周度复盘。",

  "analytics.title": "运行分析",
  "analytics.subtitle": "趋势、成功率与每个智能体的产出画像。",
  "analytics.trendTitle": "近 14 天运行趋势",
  "analytics.trendAria": "最近 14 天的运行趋势柱状图",
  "analytics.total": "总数",
  "analytics.successRate": "成功率",
  "analytics.avgDuration": "平均耗时",
  "analytics.byAgent": "各智能体运行量",

  "onboarding.title": "开启你的第一个增长工作区",
  "onboarding.subtitle": "创建工作区，承载你的模板、运行、审批与长期记忆。",
  "onboarding.nameLabel": "工作区名称",
  "onboarding.planLabel": "套餐",
  "onboarding.create": "创建工作区",
  "onboarding.creating": "创建中…",
  "onboarding.creatingAria": "正在创建工作区",
  "onboarding.createdAria": "创建工作区",
  "onboarding.nameRequired": "工作区名称为必填项",
  "onboarding.hero.badge": "增长员工系统 · P0 首发",
  "onboarding.hero.title1": "把增长",
  "onboarding.hero.title2": "交给 AI 员工",
  "onboarding.hero.desc": "内容获客、私域转化、周度复盘——三个岗位化 AI 员工，审批可回放、执行可恢复、记忆可沉淀。",
  "onboarding.feat.templates.t": "三大场景包",
  "onboarding.feat.templates.d": "内容员工 / 转化员工 / 复盘员工，开箱即用",
  "onboarding.feat.approval.t": "高危动作强制审批",
  "onboarding.feat.approval.d": "外发动作先审后发，全程留痕可回放",
  "onboarding.feat.memory.t": "产品级长期记忆",
  "onboarding.feat.memory.d": "每次运行沉淀可复用资产，越用越懂你",
  "onboarding.feat.embed.t": "嵌入任何生态",
  "onboarding.feat.embed.d": "一段脚本即可嵌入你的官网、企微或任何站点",

  "templates.title": "选择你的第一个模板",
  "templates.subtitle": "从三个 P0 首发场景包中选择一个，直接进入运行配置。",
  "templates.version": "版本",
  "templates.configure": "配置运行",
  "templates.loadError": "模板加载失败",
  "templates.names.content_acquisition": "内容获客包",
  "templates.names.private_conversion": "私域转化包",
  "templates.names.weekly_review": "周度复盘包",

  "setup.title": "配置你的运行",
  "setup.subtitle": "填写该模板的最小输入契约，然后启动运行。",
  "setup.launch": "启动运行",
  "setup.launching": "启动中…",
  "setup.launchingAria": "正在启动运行",
  "setup.launchedAria": "启动运行",
  "setup.fieldRequired": "{field} 为必填项",
  "setup.prefill": "复用来自 {runId} 的输入",
  "setup.workspaceExpired": "后端重置导致工作区失效。请重新创建工作区以继续。",
  "fields.businessSummary": "业务摘要",
  "fields.targetCustomer": "目标客户",
  "fields.preferredChannels": "首选渠道",
  "fields.contentGoal": "内容目标",
  "fields.offerAsset": "Offer 素材",
  "fields.metricsWindowDays": "指标窗口（天）",
  "fields.metricsSummary": "指标摘要（可选）",

  "status.title": "运行状态",
  "status.subtitle": "查看执行进度、审批状态与分步结果。",
  "status.readyForReview": "执行已就绪，等待查看。",
  "status.refresh": "刷新",
  "status.viewResult": "查看结果",
  "status.runAgain": "再次运行",
  "status.stepTimeline": "步骤时间线",
  "status.approvalNeeded": "需要审批",
  "status.approve": "批准",
  "status.reject": "拒绝",
  "status.stream.title": "AI 流式预览",
  "status.stream.mock": "模拟模式",
  "status.stream.generate": "生成 AI 预览",
  "status.stream.connecting": "正在连接 AI 流…",
  "status.stream.streaming": "正在流式输出…",
  "status.stream.cancel": "取消",
  "status.stream.done": "流已完成。",
  "status.stream.clear": "清空",
  "status.stream.retry": "重试",
  "status.loadError": "运行加载失败",

  "result.title": "结果详情",
  "result.subtitle": "查看输出载荷，决定下一步动作。",
  "result.readyToInspect": "结果载荷已就绪，可随时检查。",
  "result.backToStatus": "返回状态页",
  "result.runAgain": "再次运行",
  "result.payloadSection": "结果载荷",
  "result.loadError": "结果加载失败",

  "history.title": "运行历史",
  "history.subtitle": "回顾过往运行，检视产出，并复用有效的输入组合。",
  "history.emptyTitle": "还没有运行记录",
  "history.emptyBody": "启动你的第一个增长运行，开始沉淀可复用的执行历史。",
  "history.goTemplates": "前往模板",
  "history.open": "打开",
  "history.clone": "克隆",
  "history.noSummary": "暂无可用摘要。",
  "history.loadError": "历史加载失败",
  "history.workspaceExpired": "后端重置导致工作区失效。请重新创建工作区以加载历史。",

  "memory.title": "记忆管理",
  "memory.subtitle": "策展由已完成运行产出的可复用记忆。",
  "memory.emptyTitle": "还没有记忆",
  "memory.emptyBody": "完成的运行会自动创建记忆记录，你可以置顶、抑制、编辑或删除它们。",
  "memory.sourceRun": "来源运行",
  "memory.pin": "置顶",
  "memory.unpin": "取消置顶",
  "memory.suppress": "抑制",
  "memory.unsuppress": "取消抑制",
  "memory.edit": "编辑",
  "memory.save": "保存",
  "memory.cancel": "取消",
  "memory.delete": "删除",
  "memory.editAria": "编辑记忆摘要",
  "memory.sourceRunAria": "打开来源运行",
  "memory.loadError": "记忆加载失败",
  "memory.workspaceExpired": "后端重置导致工作区失效。请重新创建工作区以重建记忆。"
};

const enUS: Dictionary = {
  "common.appName": "NeuroClaw Growth",
  "common.tagline": "Your first measurable growth result in 7 days",
  "common.nav.home": "Home",
  "common.nav.analytics": "Analytics",
  "common.nav.templates": "Templates",
  "common.nav.history": "History",
  "common.nav.memory": "Memory",
  "common.nav.profile": "Brand Profile",
  "common.nav.agents": "Capability Square",
  "common.nav.library": "Library",
  "common.nav.knowledge": "Knowledge",
  "common.nav.team": "Team",
  "common.nav.inbox": "Inbox",
  "common.nav.schedule": "Schedules",
  "common.nav.workspace": "Workspace",
  "common.language": "Language",
  "common.loading": "Loading…",

  "home.title": "Growth Workspace",
  "home.subtitle": "Launch AI employees with one sentence — outputs become reusable assets.",
  "home.launch.placeholder": "e.g. Write a Xiaohongshu opening post for my maternity store…",
  "home.launch.button": "Launch",
  "home.launch.hint": "Chinese or English, auto-routed to the right employee",
  "home.stat.runs": "Total Runs",
  "home.stat.completed": "Completed Outputs",
  "home.stat.memory": "Memory Assets",
  "home.stat.pending": "Awaiting Approval",
  "home.recent": "Recent Outputs",
  "home.recentEmpty.title": "No output cards yet",
  "home.recentEmpty.body": "Start your first run with the launcher above or from templates.",
  "home.quick.templates": "Browse all templates",
  "home.greeting.morning": "Good morning",
  "home.greeting.afternoon": "Good afternoon",
  "home.greeting.evening": "Good evening",
  "home.suggestion.content": "Try asking the Content employee for 3 fresh angles today",
  "home.suggestion.review": "Weekend is near — let the Review employee summarize your week",

  "profile.title": "Brand Profile",
  "profile.subtitle": "This is how your AI employees understand your business — the more you run, the sharper it gets.",
  "profile.positioning": "Business Positioning",
  "profile.audience": "Audience Profile",
  "profile.channels": "Channel Preferences",
  "profile.tone": "Brand Tone (local draft)",
  "profile.tonePlaceholder": "e.g. Professional but warm, use emojis, avoid over-promising…",
  "profile.toneSave": "Save draft",
  "profile.toneSaved": "Saved (stored locally in this browser)",
  "profile.fromRuns": "Distilled from run inputs",
  "profile.pinned": "Pinned Memory",
  "profile.empty": "No data yet — run a few tasks first",
  "profile.manageMemory": "Manage memory",

  "render.copy": "Copy",
  "render.copied": "Copied ✓",
  "render.rawToggle": "View raw payload",
  "render.rawHide": "Hide raw payload",
  "render.noteTitleScore": "Title Score",
  "render.hashtags": "Suggested hashtags",
  "render.channels": "Fit channels",
  "render.anglePrefix": "Angle",
  "render.imageIdea": "Image idea",
  "render.chatCaption": "WeCom DM preview",
  "render.approvalReady": "Approval preview ready — human approval required before send",
  "render.actions": "Next-action checklist",
  "render.reviewSummary": "This week's review conclusion",
  "render.checkAll": "All done",

  "launch.title": "Launch Growth Task",
  "launch.subtitle": "State your goal, tap a few choices — the AI employee handles the rest.",
  "launch.welcome": "Tell me your goal, e.g. \"opening-week customer acquisition for my maternity store\", and I'll set up the pipeline.",
  "launch.ack.content_acquisition": "Got it! Content employee ready. Two quick confirmations:",
  "launch.ack.private_conversion": "Got it! Conversion employee ready. Two quick confirmations:",
  "launch.ack.weekly_review": "Got it! Review employee ready. Two quick confirmations:",
  "launch.ask.audience": "Which audience are we targeting?",
  "launch.ask.channels": "Primary channels? (multi-select)",
  "launch.ask.product": "What deliverable do you need?",
  "launch.ask.confirm": "Confirm and the pipeline executes automatically:",
  "launch.confirmChoice": "Next",
  "launch.restart": "Start over",

  "pipeline.preflight": "Policy Preflight",
  "pipeline.extract": "Data / Browser Extraction",
  "pipeline.generate": "AI Content Generation",
  "pipeline.approval": "Human Approval Gate",
  "pipeline.deliver": "Deliver & Deposit",

  "agents.title": "Capability Square",
  "agents.subtitle": "Your agent roster and the external tools (MCP plugins) they can call.",
  "agents.builtin": "Built-in",
  "agents.custom": "Custom agent",
  "agents.create": "✦ Create agent",
  "agents.nameCol": "Name",
  "agents.engineCol": "Base engine",
  "agents.statusCol": "Status",
  "agents.actionsCol": "Actions",
  "agents.enable": "Enable",
  "agents.disable": "Disable",
  "agents.launch": "Launch",
  "agents.mcpTitle": "MCP Plugin Servers",
  "agents.mcpEmpty": "No MCP servers configured. Set NEUROCLAW_MCP_SERVERS in .env to plug into the global ecosystem.",
  "agents.toolsCount": "tools",
  "agents.connected": "Connected",
  "agents.disconnected": "Disconnected",

  "builder.title": "Create Agent",
  "builder.subtitle": "Tap through choices — your custom growth employee in one minute.",
  "builder.step.base": "Pick a base capability",
  "builder.base.content_acquisition.d": "Content angles, channel fit, hashtags",
  "builder.base.private_conversion.d": "Conversion copy with approval gate & delivery",
  "builder.base.weekly_review.d": "Turn metrics into review + action list",
  "builder.step.focus": "Focus areas (multi-select)",
  "builder.step.style": "Output style",
  "builder.style.structured": "Structured cards",
  "builder.style.checklist": "Action checklist",
  "builder.style.copy": "Ready-to-use copy",
  "builder.step.toolbind": "Bind MCP tools (optional)",
  "builder.toolbind.none": "Skip tool binding for now",
  "builder.step.identity": "Name your agent",
  "builder.field.name": "Agent name",
  "builder.field.slug": "Slug (lowercase letters/digits/underscore)",
  "builder.confirm": "Create agent",
  "builder.creating": "Creating…",
  "builder.done": "Added to Capability Square ✓",

  "library.title": "Artifacts Library",
  "library.subtitle": "Every completed run deposits a reusable deliverable.",
  "library.filter.all": "All",
  "library.filter.note": "Notes",
  "library.filter.copy": "Copy",
  "library.filter.report": "Reports",
  "library.open": "Open run",
  "library.empty": "No artifacts yet — run a few tasks first",
  "library.download": "Download JSON",
  "library.deleted": "Deleted",

  "knowledge.title": "Knowledge Base",
  "knowledge.subtitle": "Deposit brand facts & playbooks — agents cite them automatically.",
  "knowledge.addTitle": "Title",
  "knowledge.addContent": "Content (facts / playbook / preferences)",
  "knowledge.addTags": "Tags (comma-separated, optional)",
  "knowledge.add": "Add entry",
  "knowledge.empty": "No entries yet. Start with: brand intro, target audience, tone rules, past hits.",
  "knowledge.delete": "Delete",
  "knowledge.attachedHint": "Tick entries in the launch flow to inject them into prompts",

  "team.title": "Agent Teams",
  "team.subtitle": "One goal, multiple employees in relay — outputs feed the next stage.",
  "team.playbook.sprint.name": "Opening Sprint",
  "team.playbook.sprint.desc": "Content employee drafts → Conversion employee writes DM copy → Review employee gives action list",
  "team.playbook.contentReview.name": "Content Weekly Loop",
  "team.playbook.contentReview.desc": "Content employee batches angles → Review employee prioritizes",
  "team.goalLabel": "Team goal",
  "team.audienceLabel": "Target audience",
  "team.start": "🚀 Launch team relay",
  "team.running": "Running…",
  "team.step": "Stage",
  "team.done": "Done",
  "team.failed": "Failed",

  "inbox.title": "Approval Inbox",
  "inbox.subtitle": "Every outbound action waiting for human approval, in one place.",
  "inbox.emptyTitle": "Inbox zero ✓",
  "inbox.emptyBody": "New high-risk sends will land here the moment they appear.",
  "sched.title": "Scheduled Runs",
  "sched.subtitle": "Put your AI employees on a cadence — e.g. topics every morning.",
  "sched.frequency": "Frequency",
  "sched.freq.demo": "Every 5 min (demo)",
  "sched.freq.daily": "Daily",
  "sched.freq.weekly": "Weekly",
  "sched.add": "Create schedule",
  "sched.empty": "No schedules yet. Tip: auto-run the weekly review every Monday.",

  "analytics.title": "Run Analytics",
  "analytics.subtitle": "Trends, success rate and per-agent output profile.",
  "analytics.trendTitle": "Last 14 days",
  "analytics.trendAria": "Bar chart of runs over the last 14 days",
  "analytics.total": "Total",
  "analytics.successRate": "Success rate",
  "analytics.avgDuration": "Avg duration",
  "analytics.byAgent": "Runs by agent",

  "onboarding.title": "Start Your First Growth Workspace",
  "onboarding.subtitle": "Create the workspace that will own your templates, runs, approvals, and memory.",
  "onboarding.nameLabel": "Workspace Name",
  "onboarding.planLabel": "Plan",
  "onboarding.create": "Create Workspace",
  "onboarding.creating": "Creating…",
  "onboarding.creatingAria": "Creating workspace",
  "onboarding.createdAria": "Create workspace",
  "onboarding.nameRequired": "Workspace Name is required",
  "onboarding.hero.badge": "Growth Employee System · P0 Launch",
  "onboarding.hero.title1": "Hand Growth",
  "onboarding.hero.title2": "to AI Employees",
  "onboarding.hero.desc":
    "Content acquisition, private conversion, weekly review — three role-based AI employees with approval gates, replayable execution, and durable memory.",
  "onboarding.feat.templates.t": "Three Scenario Packs",
  "onboarding.feat.templates.d": "Content / Conversion / Review employees, ready out of the box",
  "onboarding.feat.approval.t": "Approval-Gated High-Risk Actions",
  "onboarding.feat.approval.d": "Review before send; fully audited and replayable",
  "onboarding.feat.memory.t": "Product-Grade Long-Term Memory",
  "onboarding.feat.memory.d": "Every run deposits reusable assets that compound",
  "onboarding.feat.embed.t": "Embeds Into Any Ecosystem",
  "onboarding.feat.embed.d": "One script tag to embed into your site, WeCom, or anywhere",

  "templates.title": "Choose Your First Template",
  "templates.subtitle": "Pick one of the three P0 launch packs and move straight into run setup.",
  "templates.version": "Version",
  "templates.configure": "Configure Run",
  "templates.loadError": "Failed to load templates",
  "templates.names.content_acquisition": "Content Acquisition",
  "templates.names.private_conversion": "Private Conversion",
  "templates.names.weekly_review": "Weekly Review",

  "setup.title": "Configure Your Run",
  "setup.subtitle": "Fill the minimum input contract for this template and launch the run.",
  "setup.launch": "Launch Run",
  "setup.launching": "Launching…",
  "setup.launchingAria": "Launching run",
  "setup.launchedAria": "Launch run",
  "setup.fieldRequired": "{field} is required",
  "setup.prefill": "Reusing input from {runId}",
  "setup.workspaceExpired": "Your workspace expired after a backend reset. Create a new workspace to continue.",
  "fields.businessSummary": "Business Summary",
  "fields.targetCustomer": "Target Customer",
  "fields.preferredChannels": "Preferred Channels",
  "fields.contentGoal": "Content Goal",
  "fields.offerAsset": "Offer Asset",
  "fields.metricsWindowDays": "Metrics Window Days",
  "fields.metricsSummary": "Metrics Summary (optional)",

  "status.title": "Run Status",
  "status.subtitle": "Review execution progress, approval state, and step-level outcomes.",
  "status.readyForReview": "Execution is ready for review.",
  "status.refresh": "Refresh",
  "status.viewResult": "View Result",
  "status.runAgain": "Run Again",
  "status.stepTimeline": "Step Timeline",
  "status.approvalNeeded": "Approval Needed",
  "status.approve": "Approve",
  "status.reject": "Reject",
  "status.stream.title": "Stream AI Preview",
  "status.stream.mock": "Mock Mode",
  "status.stream.generate": "Generate AI Preview",
  "status.stream.connecting": "Connecting to AI stream…",
  "status.stream.streaming": "Streaming AI output…",
  "status.stream.cancel": "Cancel",
  "status.stream.done": "Stream completed.",
  "status.stream.clear": "Clear",
  "status.stream.retry": "Retry",
  "status.loadError": "Failed to load run",

  "result.title": "Result Detail",
  "result.subtitle": "Review the output payload and decide what to do next.",
  "result.readyToInspect": "Result payload is ready to inspect.",
  "result.backToStatus": "Back to Status",
  "result.runAgain": "Run Again",
  "result.payloadSection": "Result payload",
  "result.loadError": "Failed to load result",

  "history.title": "Run History",
  "history.subtitle": "Review previous runs, inspect outcomes, and reuse a working input set.",
  "history.emptyTitle": "No runs yet",
  "history.emptyBody": "Launch your first Growth run to start building reusable execution history.",
  "history.goTemplates": "Go to Templates",
  "history.open": "Open",
  "history.clone": "Clone",
  "history.noSummary": "No summary available yet.",
  "history.loadError": "Failed to load history",
  "history.workspaceExpired": "Your workspace expired after a backend reset. Create a new workspace to reload history.",

  "memory.title": "Memory Settings",
  "memory.subtitle": "Curate the reusable memory created by completed runs.",
  "memory.emptyTitle": "No memory yet",
  "memory.emptyBody": "Completed runs will automatically create memory records you can pin, suppress, edit, or delete.",
  "memory.sourceRun": "Source Run",
  "memory.pin": "Pin",
  "memory.unpin": "Unpin",
  "memory.suppress": "Suppress",
  "memory.unsuppress": "Unsuppress",
  "memory.edit": "Edit",
  "memory.save": "Save",
  "memory.cancel": "Cancel",
  "memory.delete": "Delete",
  "memory.editAria": "Edit memory summary",
  "memory.sourceRunAria": "Open source run",
  "memory.loadError": "Failed to load memory",
  "memory.workspaceExpired": "Your workspace expired after a backend reset. Create a new workspace to rebuild memory."
};

const dictionaries: Record<Locale, Dictionary> = {
  "zh-CN": zhCN,
  "en-US": enUS
};

function resolveInitialLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "zh-CN" || stored === "en-US") return stored;
  } catch {
    // storage unavailable — fall through to default
  }
  return "zh-CN";
}

interface I18nContextValue {
  locale: Locale;
  embed: boolean;
  setLocale: (locale: Locale) => void;
  /** Translate a dictionary key; `{placeholder}` tokens are replaced from vars. */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(resolveInitialLocale);
  const [embed] = useState<boolean>(
    () => new URLSearchParams(window.location.search).get(EMBED_PARAM) === "1"
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // storage unavailable — locale stays for the session only
    }
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const raw = dictionaries[locale][key] ?? dictionaries["en-US"][key] ?? key;
      if (!vars) return raw;
      return Object.entries(vars).reduce(
        (acc, [name, value]) => acc.replaceAll(`{${name}}`, String(value)),
        raw
      );
    },
    [locale]
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, embed, setLocale, t }),
    [locale, embed, setLocale, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div
      className="lang-switch"
      role="group"
      aria-label={t("common.language")}
    >
      {(["zh-CN", "en-US"] as const).map((option) => (
        <button
          key={option}
          type="button"
          className={`lang-option${locale === option ? " active" : ""}`}
          aria-pressed={locale === option}
          onClick={() => setLocale(option)}
        >
          {option === "zh-CN" ? "中文" : "EN"}
        </button>
      ))}
    </div>
  );
}
