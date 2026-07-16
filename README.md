# OpenClaw 执行门模板

一个面向 OpenClaw 的低摩擦执行安全模板。

项目目标不是让所有操作都需要审批，而是在尽量不影响正常使用的前提下，重点防止：

- 模型误操作；
- 重复执行；
- 自动化越权；
- 误下单和误支付；
- 向错误对象发送消息；
- 删除重要数据；
- 修改关键安全配置；
- 因局部异常导致整个系统不可用。

本仓库已进行脱敏处理，不包含生产数据库、真实 Token、个人身份、账号信息、个人记忆、私有业务模块或历史运行状态。

## 核心原则

```text
普通操作直接执行
固定能力通过注册表接入
权限扩大需要确认
资金、秘密和破坏性操作严格保护
配置问题必须可诊断、可恢复
```

## 四级风险模型

| 等级 | 类型 | 默认行为 |
|---|---|---|
| L0 | 只读、查询、诊断 | 直接执行 |
| L1 | 已登记、低风险、可恢复能力 | 直接执行 |
| L2 | 有影响但可恢复，或扩大权限 | 确认一次 |
| L3 | 资金、秘密、破坏性或不可逆操作 | 严格确认或拒绝 |

直接允许不代表无限权限。L0/L1 仍受到路径、Agent、Channel、Actor、Grant、固定 executable 和精确 argv 的限制。

## CONFIG_ERROR 与确认分离

`allowlist miss` 和未登记 executable 属于执行配置问题，不是用户尚未授权。

正确流程：

```text
Gate 风险判断
→ Host approvals 预检
→ 命中：继续执行
→ 未命中：CONFIG_ERROR
```

`CONFIG_ERROR` 不会：

- 创建 `WAIT_CONFIRM`；
- 要求用户反复回复“确认”；
- 写入成功去重状态；
- 自动扩大白名单。

未知 Shell、解释器、脚本和未登记 executable 默认仍被拒绝。

## 事务式 Skill 注册

执行型 Skill 使用一份脱敏的：

```text
execution-manifest.json
```

注册流程：

```text
execution-manifest.json
→ 事务注册器
→ Skill Registry
→ Execution Gate
→ Host approvals
→ Gateway 运行时验证
```

提供以下命令：

```text
skill inspect
skill register
skill update
skill verify
skill remove
skill list
```

标准流程：

```bash
node bin/skill-registry-cli.mjs skill inspect examples/skills/example-skill
node bin/skill-registry-cli.mjs skill register examples/skills/example-skill
node bin/skill-registry-cli.mjs skill register examples/skills/example-skill --apply
node bin/skill-registry-cli.mjs skill verify examples/skills/example-skill
```

注册器默认 dry-run，并具备：

- 原子事务；
- 修改前自动备份；
- 失败自动回滚；
- 重复注册幂等；
- Manifest 严格校验；
- executable、argv、cwd、超时和环境约束精确匹配；
- Gateway 重启后验证；
- 审计和撤销能力。

详细说明见：

```text
docs/SKILL-REGISTRATION.md
```

## Automation Grant

Automation Grant 用于限制自动化任务的真实权限范围。

每个 Grant 可以绑定：

```text
jobId
agentId
tool
capability
resource
固定命令
通知目标
运行上下文
周期与次数
```

已有且有效的低风险自动化可以在原授权范围内直接运行。额度耗尽、周期未刷新或作用域不匹配时，系统应拒绝当前运行，不得自动新建、扩容、重置或绕过 Grant。

## REM 记忆扫描

模板支持 REM 类记忆整理任务。

允许在受限范围内读取：

```text
MEMORY.md
memory/**/*.md
topics/**/*.md
.learnings/**/*.md
```

单个文件或目录缺失不应终止整个扫描，可以记录为：

```text
SUCCESS
MISSING
READ_FAILED
PARSE_FAILED
SKIPPED
```

REM 权限不能扩大到凭据、私钥、认证文件、其他用户目录或未授权 Agent 目录。

## 福利任务编排

低风险福利任务可以由父级 Agent 编排，但不同平台必须使用独立的：

```text
tool
capability
grant
固定入口
去重状态
```

查询、领取和本人通知可在有效 Grant 内直接执行；下单、支付、购买、开通会员和自动续费继续严格保护。

## 完整性监控

策略文件哈希不一致默认使用：

```text
WARN_ONLY
```

系统记录警告和审计信息，但不应因此把读取、诊断、REM 和所有自动化整体锁死。

## 本地恢复 CLI

恢复 CLI 仅允许服务器本地受信任用户调用，不监听网络，也不能由远程消息触发。

参考能力：

```text
status
diagnose
approvals list
approvals add-fixed
approvals remove
policy validate
policy restore-backup
gateway restart
undo
```

恢复工具不得提供支付、下单、危险删除、秘密导出或任意 Shell 放行能力。

## 目录结构

```text
openclaw_plan/
├── src/                         Execution Gate 通用源码
├── test/                        测试
├── sql/                         SQLite Schema
├── scripts/                     安装、恢复和脱敏检查脚本
├── config/                      示例配置
├── policy/                      示例安全策略
├── examples/                    REM、福利任务和平台示例
├── docs/                        架构、恢复和安全文档
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

环境建议：

```text
Node.js >= 22
OpenClaw >= 2026.6.11
Linux 或兼容 Shell 环境
SQLite
```

克隆仓库：

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

创建私有覆盖层：

```bash
mkdir -p private-overlay
cp .env.example private-overlay/.env
```

不要直接把公开模板目录作为生产运行目录。建议安装到独立运行目录，并把真实配置保存在仓库外。

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

## 已知限制

本仓库只能恢复：

```text
通用代码
策略框架
数据库结构
示例配置
安装方式
测试
```

它不是生产实例备份，不能单独恢复真实 Token、账号、个人记忆、生产 Cron、Grant、数据库历史或私有业务模块。

## 发布前安全检查

至少确认：

```text
Telegram Bot 已设置白名单
没有不必要的公网端口
数据库文件权限正确
private-overlay 未被 Git 跟踪
真实 Token 未写入代码
高风险能力仍受保护
未知 Shell 和脚本仍被拒绝
```

## 许可证

本项目使用 MIT License。

<!-- 用途：项目说明、风险模型、Skill 注册、安装和恢复指南。 -->
