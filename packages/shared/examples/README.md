# 通用接入配置示例（simulation-only）

`demo_sandbox.integration.json` 是一个纯数据示例：仅声明 5 个必填身份字段
（projectKey / projectTypeKey / packId / adapterId / sourceSystem），其余全部由
通用内核 `src/project-integration.ts` 的 simulation-safe 默认值填充。项目名只作为
数据出现，内核不含任何项目名分支。

从 `p0-growth-v1` 目录校验：

```sh
node scripts/validate-integration-config.mjs packages/shared/examples/demo_sandbox.integration.json
```

该命令通过通用内核完成 schema 解析、Pack/Adapter/Workflow 派生、注册记录构建与
fail-closed 门禁校验；无需改动内核。接入步骤见 `../../../docs/onboarding.md`。
