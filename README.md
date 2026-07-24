# OpenClaw Execution Gate

一个面向 OpenClaw 单用户自用环境的执行安全模板。

项目目标：

```text
用户负责审批
系统负责执行
正常工具保持可用
高影响操作执行前确认
```

本仓库已进行脱敏处理，不包含生产数据库、真实 Token、个人身份、账号信息、个人记忆、私有业务模块或历史运行状态。

## 当前模型

```text
Agent 调用正常工具
→ Gateway 捕获结构化调用
→ Execution Gate / Operation Bus 判断风险
→ 必要时冻结原始调用并返回 WAIT_CONFIRM
→ 用户批准
→ 恢复并执行被冻结的完全相同调用
→ 将结果返回原会话
```

Operation Bus 是透明安全拦截层，不是正常工具的替代品。

正常业务工具应继续对 Agent 可见，包括：

```text
exec
read
write
edit
browser
web_fetch
已安装并启用的 MCP 工具
```

环境不一定存在单独名为 `bash` 的工具；Bash 能力可以通过 `exec` 提供。

禁止因 adapter 不完整而隐藏全部工具、要求用户 SSH、生成 `/tmp/*.sh` 让用户手动执行，或在批准后重新生成命令。

## 审批卡

普通审批卡固定显示三个选项：

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

其中 `allow-always` 不表示永久放行，而是创建固定 300 秒的：

```text
SCOPED_TIME_WINDOW
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

时间窗内的每次调用仍经过 Operation Bus、范围检查和审计。授权可通过：

```text
/revoke-5min-allow
```

主动撤销。

## 操作备注

每张审批卡必须显示通俗中文备注：

```text
操作备注：
用普通中文说明该操作准备做什么，以及批准后的主要影响。
```

备注要求：

- 通常为 1～3 句话；
- 不直接复制完整命令；
- 不泄露 Token、Cookie、Authorization、密码或私钥；
- 在 operation 创建时生成、脱敏并保存；
- 审批渲染时读取已保存备注；
- 批准时不得重新生成；
- 用户传入的 `note`、`operationNote` 等字段不能覆盖系统备注。

## 审批链不变量

需要审批的调用至少冻结：

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

批准后必须：

```text
校验 operationId 与 canonicalHash
校验 actor/channel/session/runId
原子一次性消费
执行已保存的原始调用
将结果返回原会话
```

重复批准必须返回：

```text
ALREADY_CONSUMED
```

不得重新解析用户原话、重新生成命令或用另一个动作替换被冻结调用。

## 风险边界

```text
纯内存分析与计划生成
→ ALLOW_INTERNAL

普通工具调用
→ 无有效时间窗时 WAIT_CONFIRM
→ 命中有效 5 分钟范围授权时执行

支付、最终下单、转账
→ FINANCIAL_STEP_UP

凭据导出、系统破坏、块设备写入
→ DENY

安全核心修改
→ ADMIN_PLANE_REQUIRED
```

“5分钟内允许所有”不能覆盖：

- 真实支付；
- 最终下单；
- 转账；
- 导出 Token、Cookie、密码或私钥；
- 将秘密发送到外部；
- 修改 Operation Bus、确认规则或 DENY 规则；
- 关闭审计；
- 修改 Integrity 或 Bootstrap；
- 系统根目录破坏；
- 写入块设备。

金融审批卡只显示：

```text
确认本次交易
拒绝
```

## Skill、插件和依赖安装

安装类操作使用隔离检查与双阶段提交：

```text
第一次确认
→ 下载到 staging
→ 检查文件、依赖、lifecycle scripts、MCP 和配置差异
→ 展示检查报告

第二次确认
→ 写入正式目录
→ 应用 MCP / 插件配置事务
→ reload Gateway
→ discovery / doctor / probe
→ 成功提交或失败回滚
```

普通 Skill 与带 MCP 的 Skill 使用同一安装流程。安装过程中不得要求用户手动运行终端命令。

## 管理面

真正修改安全核心时使用本地管理入口：

```text
openclaw-admin
```

以下属于管理面：

- 修改 Execution Gate 或 Operation Bus 核心；
- 修改确认、授权或 DENY 规则；
- 修改审计安全实现；
- 修改 Integrity Hash；
- 修改 Bootstrap；
- 关闭或绕过安全系统；
- 修改管理面自身。

普通 Skill/MCP 管理、依赖安装、测试、构建、业务配置和正常 Gateway reload 不应错误归类为管理面。

## 适配版本

```text
Node.js 22.x
OpenClaw 2026.6.11
OpenClaw 2026.7.1-2
Linux
SQLite
```

其中：

- `2026.6.11` 保留原生审批 decision 数量兼容；
- `2026.7.1-2` 为当前透明审批、中文审批卡和 5 分钟授权的适配基线；
- 其他版本不在本仓库当前声明的适配范围内。

## 目录结构

```text
openclaw_plan/
├── src/                         Execution Gate 通用源码
├── test/                        测试
├── sql/                         SQLite Schema
├── scripts/                     安装、恢复和脱敏检查脚本
├── config/                      示例配置
├── policy/                      示例安全策略
├── examples/                    脱敏示例
├── docs/                        架构、当前状态和安全文档
├── archive/                     较大源码与测试的脱敏归档
├── .env.example
├── .gitignore
├── openclaw.plugin.json
├── package.json
├── SECURITY.md
├── SANITIZATION.md
└── LICENSE
```

## 安装

```bash
git clone <REPOSITORY_URL> ~/openclaw-execution-gate-template
cd ~/openclaw-execution-gate-template
npm install
```

部分较大的源码和测试文件保存在：

```text
archive/remaining-files.tgz.b64
```

恢复：

```bash
bash scripts/restore-remaining-files.sh
```

不要把公开模板直接当作生产实例备份。真实配置、凭据、数据库和私有业务数据应保存在仓库外。

## 测试与脱敏检查

```bash
npm test
npm run build
npm run verify
```

对不含 `.git` 的干净导出目录：

```bash
bash scripts/verify-public-template.sh --release
```

公开导出默认排除：

```text
.env
数据库
日志
备份
会话记录
聊天记录
缓存
个人记忆
Token
Cookie
私钥
真实账号和身份
私有业务实现
```

## 公开仓库边界

本仓库只能提供：

```text
通用代码
安全策略框架
数据库结构
示例配置
安装方式
测试
脱敏文档
```

它不是生产实例备份，不能单独恢复真实 Token、账号、个人记忆、生产 Cron、审批数据库或私有业务模块。

## 许可证

本项目使用 MIT License。

<!-- 用途：项目说明、透明审批模型、适配版本、安装和公开边界。 -->