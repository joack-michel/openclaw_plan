# OpenClaw Execution Gate 公开仓库当前状态

> 更新时间：2026-07-24
>
> 本文只描述公开、脱敏模板和最近一次已报告的生产验收摘要。生产数据库、真实 Token、账号、日志、私有业务参数和运行时秘密不属于本仓库。

## 1. 仓库定位

该仓库提供 OpenClaw Execution Gate 的脱敏公开模板、测试、文档和发布检查。

当前公开基线包括：

- 透明 Operation Bus；
- 正常 `exec`、文件、浏览器、`web_fetch` 和 MCP 工具保持对 Agent 可见；
- 工具调用执行前冻结原始结构化参数；
- `operationId`、`canonicalHash`、actor/channel/session/runId 绑定；
- 确认后恢复并执行被冻结的原始调用；
- 一次性消费与 `ALREADY_CONSUMED` 防重放；
- 中文审批卡和脱敏“操作备注”；
- 固定 300 秒的 `SCOPED_TIME_WINDOW`；
- 金融强确认与秘密、破坏性操作隔离；
- 公开模板秘密和私人数据扫描。

## 2. 当前运行模型

```text
用户负责审批
系统负责执行
正常工具保持可用
Operation Bus 负责透明拦截
```

正确流程：

```text
Agent 调用正常工具
→ Gateway 捕获结构化调用
→ Operation Bus 冻结原始调用
→ 返回 WAIT_CONFIRM
→ 用户批准
→ 自动执行被冻结的完全相同调用
→ 结果返回原会话
```

不得因 adapter 不完整而隐藏全部工具、要求用户 SSH、生成临时脚本让用户执行，或在批准后重新生成命令。

## 3. 普通审批卡

普通卡固定显示：

```text
仅允许一次
5分钟内允许所有
拒绝
```

内部 callback decision 保持：

```text
allow-once
allow-always
deny
```

`allow-always` 当前解释为：

```text
SCOPED_TIME_WINDOW
TTL = 300 秒
```

授权绑定：

```text
actorId
channelId
sessionId
Gateway bootId
policyVersion
expiresAt
scope
```

时间窗内每次调用仍逐次经过 Operation Bus、范围检查和审计。

用户可以主动撤销：

```text
/revoke-5min-allow
```

## 4. 审批备注

每张审批卡应显示：

```text
操作备注：
用普通中文说明准备做什么，以及批准后的主要影响。
```

备注必须在 operation 创建时生成、脱敏并保存，审批时读取已保存内容，批准时不得重新生成。

备注不得：

- 直接复制完整命令；
- 泄露 Token、Cookie、Authorization、密码或私钥；
- 被用户传入的 `note`、`operationNote` 等字段覆盖。

## 5. 金融和高风险边界

以下操作不能被 5 分钟授权覆盖：

- 真实支付；
- 最终下单；
- 转账；
- 凭据导出；
- 将秘密发送到外部；
- 修改安全核心或确认规则；
- 关闭审计；
- 修改 Integrity 或 Bootstrap；
- 系统根目录破坏；
- 写入块设备。

金融审批卡只显示：

```text
确认本次交易
拒绝
```

## 6. 最近生产验收摘要

最近一次已报告结果：

```text
普通审批卡：仅允许一次 / 5分钟内允许所有 / 拒绝
allow-always：固定 300 秒 SCOPED_TIME_WINDOW
主动撤销：/revoke-5min-allow
金融卡：确认本次交易 / 拒绝
Gateway：已重启并确认 execution-gate 加载
服务：active
npm test：通过
npm run build：通过
git diff --check：通过
```

自动化覆盖包括：

- 授权范围匹配；
- 越界拦截；
- 主动撤销；
- 300 秒过期；
- Gateway boot 绑定；
- policy version 绑定；
- 金融、秘密、安全核心、破坏和块设备操作不被覆盖。

未主动向现有 Telegram 会话注入专用待审批测试任务；生产运行状态以实际 Gateway 和日常使用结果为准。

## 7. 适配版本

```text
Node.js 22.x
OpenClaw 2026.6.11
OpenClaw 2026.7.1-2
Linux
SQLite
```

说明：

- `2026.6.11` 保留原生审批 schema 和三 decision 兼容；
- `2026.7.1-2` 为当前透明审批、中文按钮和 5 分钟授权的适配基线；
- 其他 OpenClaw 版本不在当前公开声明范围内。

## 8. 公开与生产边界

本仓库不得包含：

- `.env` 或真实 Token；
- Cookie、Authorization、密码、私钥；
- 生产 `openclaw.json`；
- 设备 identity；
- 生产 Registry、approvals、数据库和备份；
- 真实服务器地址、个人地址、金额、账单和私有业务数据；
- 一次性调试日志和 smoke 产物。

## 9. 后续同步原则

向公开仓库同步源码或文档前必须确认：

1. 来源是当前、真实、干净的本地 Git 工作区；
2. 远端历史与本地历史可快进合并；
3. 测试、构建和 `git diff --check` 通过；
4. 秘密和私人数据扫描通过；
5. 不包含生产配置、运行数据库、日志或私有业务实现；
6. 不使用 force push。