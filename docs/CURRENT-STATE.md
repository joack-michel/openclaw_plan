# OpenClaw Execution Gate 公开仓库当前状态

> 更新时间：2026-07-23
>
> 本文只描述公开、脱敏模板。生产 Gateway、Registry、approvals、数据库、日志、私有业务参数和真实凭据不属于本仓库，也不能由本文证明其当前运行状态。

## 1. 仓库定位

该仓库提供 OpenClaw Execution Gate 的脱敏公开模板、测试、文档和发布检查。

当前公开基线包括：

- L0/L1/L2/L3 风险模型；
- 结构化 `mcp_manage`；
- 配置变更的 `WAIT_CONFIRM`；
- 冻结规范化参数与参数哈希；
- 确认后读取冻结请求；
- 一次性消费与重复执行保护；
- 公开模板秘密和私人数据扫描。

## 2. 长期模型

当前长期原则：

```text
低摩擦
可恢复
按实际后果判断风险
用户负责审批，系统负责执行
```

正常业务工具应保持对 Agent 可见，Operation Bus 负责执行前拦截与确认，而不是替代或隐藏全部工具。

## 3. 审批链要求

公开模型要求审批操作绑定：

```text
toolName
toolCallId
normalizedArguments
actorId
channelId
sessionId
runId
canonicalHash
resultRoute
expiresAt
approvalScope
```

批准后必须执行已保存的原始调用；不得重新生成命令或重新解析用户原话。重复批准应返回 `ALREADY_CONSUMED`。

不同任务即使 session、工具和参数相同，只要 `runId` 不同，也不得复用上一任务的 operation 或任务级授权。

## 4. 审批界面要求

公开模型已补充以下界面要求：

- 用户可见字段和按钮使用中文；
- 机器枚举、Hash、operation ID 和工具名保持原文；
- 每张审批卡显示通俗、脱敏的“操作备注”；
- 操作备注在 operation 创建时生成并保存；
- 审批时读取已保存备注，不在批准时重新生成；
- 用户传入的 note 字段不能覆盖系统备注；
- 同一字段不得被内外 formatter 重复渲染。

## 5. 公开与生产边界

本仓库不得包含：

- `.env` 或真实 Token；
- Cookie、Authorization、密码、私钥；
- 生产 `openclaw.json`；
- 设备 identity；
- 生产 Registry、approvals、数据库和备份；
- 真实服务器地址、个人地址、金额、账单和私有业务数据；
- 一次性调试日志和 smoke 产物。

## 6. 验证边界

本次 GitHub 更新只更新公开文档，不声称完成以下生产验收：

- Gateway 当前是否 active；
- 生产环境是否加载最新本地提交；
- 真实审批卡是否已显示“操作备注”；
- 用户点击后冻结调用是否在生产环境自动执行；
- 重复批准是否在生产环境返回 `ALREADY_CONSUMED`；
- 本地未推送提交是否与公开模板完全一致。

这些结论必须由生产运行时、当前 Git 状态和当次测试结果单独验证。

## 7. 后续同步原则

后续向公开仓库同步源码前，必须先确认：

1. 来源是当前、真实、干净的本地 Git 工作区；
2. 远端历史与本地历史可快进合并；
3. 测试、构建和 `git diff --check` 通过；
4. 秘密和私人数据扫描通过；
5. 不包含生产配置、运行状态和私有业务实现；
6. 不使用 force push。
