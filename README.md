# OpenClaw Execution Gate

> 让 AI 真正执行任务，而不是在“什么都不能做”和“什么都能做”之间二选一。

OpenClaw Execution Gate 是一套运行在真实个人服务器环境中的 OpenClaw 安全执行实践。

它解决的核心问题不是“如何彻底限制 AI”，而是：

```text
怎样让 AI 正常使用文件、exec、Skill、MCP 和自动化工具，
同时降低误操作、重复执行、不可恢复破坏和凭据泄露的风险。
```

本项目面向单用户自托管环境，追求：

```text
低摩擦
可恢复
按实际后果判断风险
用户负责审批，系统负责执行
```

它不是多租户权限平台、企业 IAM、零信任系统或通用恶意代码沙箱。

## 为什么需要它

普通 AI Agent 往往处于两个极端。

### 权限太少

Agent 可以分析问题和生成命令，但真正执行时仍要求用户登录服务器、复制命令、运行临时脚本，再把输出粘贴回来。复杂任务会在人与 Agent 之间反复中断。

### 权限太大

Agent 可以直接执行所有操作，但一次误判、重复请求或上下文混乱，可能造成：

```text
文件被错误删除
消息被重复发送
同一操作被执行两次
业务配置被意外覆盖
凭据出现在日志或审批卡中
高影响外部操作失控
```

### 第三种方式

OpenClaw Execution Gate 采用透明执行保护：

```text
普通安全操作低摩擦执行
高影响操作先冻结并说明影响
用户批准后执行被冻结的原始调用
重复批准不会再次执行
安全核心始终与 Agent 隔离
```

## 核心流程

```text
用户提出任务
    ↓
Agent 调用正常工具
    ↓
OpenClaw Gateway 捕获结构化工具调用
    ↓
Execution Gate 判断实际影响
    ├─ 已证明安全的只读操作 → 直接执行
    ├─ 命中任务授权或固定自动化授权 → 在明确范围内执行
    ├─ 普通写入、外部副作用或破坏性操作 → WAIT_CONFIRM
    ├─ 支付、最终下单或转账 → FINANCIAL_STEP_UP
    ├─ 凭据导出或系统破坏 → DENY
    └─ 修改安全核心 → ADMIN_PLANE_REQUIRED
```

需要审批时，系统冻结原始工具调用和执行上下文。用户批准后，系统会：

```text
校验 operationId
校验 canonicalHash
校验 actor / channel / session / runId
原子一次性消费审批
执行已保存的完全相同调用
把结果返回原会话
```

系统不会重新让模型生成命令、重新解析用户原话、用另一个动作替换原调用，也不会生成临时脚本要求用户手动执行。

## 与普通审批插件的区别

| 能力 | OpenClaw Execution Gate |
|---|---|
| 正常工具是否可见 | `exec`、文件工具、浏览器和 MCP 工具继续对 Agent 可见 |
| 拦截方式 | Gateway 捕获原生结构化调用，Execution Gate 透明判断 |
| 风险判断 | 根据实际后果判断，不只根据程序名称或字符判断 |
| 审批内容 | 展示通俗中文操作备注，而不是倾倒完整命令 |
| 批准后执行 | 执行被冻结的原始调用，不重新生成 |
| 防重复执行 | 审批只能消费一次，重复批准返回 `ALREADY_CONSUMED` |
| 授权范围 | 绑定用户、频道、会话、任务、Agent、Gateway 启动周期和有效期 |
| 固定自动化 | 支持窄范围 Automation Grant 和精确 Cron 豁免 |
| 支付和转账 | 永远不能被普通时间窗或任务授权覆盖 |
| 安全核心 | 与普通业务面隔离，只允许本地管理流程修改 |
| 恢复能力 | 状态和管理操作按备份、事务与回滚设计 |

Operation Bus 是安全拦截层，不是正常工具的替代品。正常工具不应因为缺少专用 adapter 而消失，也不应把普通调用统一降级为 `OPERATION_BUS_REQUIRED`。

## 风险处理模型

| 操作类型 | 默认结果 |
|---|---|
| 已证明安全的本地只读操作 | 直接允许 |
| 已知只读 MCP 查询 | 直接允许 |
| 普通文件修改 | 首次请求审批，批准后可由当前任务授权覆盖 |
| 测试、构建和可信开发操作 | 按实际副作用判断 |
| MCP 写入或外部账号修改 | `WAIT_CONFIRM` |
| 第三方消息发送 | `WAIT_CONFIRM` |
| 批量或不可恢复删除 | `WAIT_CONFIRM` |
| 固定且已登记的自动化 | 在精确授权范围内执行 |
| 支付、最终下单、转账 | `FINANCIAL_STEP_UP` |
| 导出 Token、Cookie、密码或私钥 | `DENY` |
| 系统根目录破坏或块设备写入 | `DENY` |
| 修改审批规则、Integrity 或 Bootstrap | `ADMIN_PLANE_REQUIRED` |

风险根据实际结果判断，而不是简单规定 Node、Python、Bash 或 MCP 一律允许或一律拒绝。

## 审批卡与中文操作备注

普通审批卡显示通俗中文备注：

```text
操作备注：
将运行项目测试，检查本次代码修改是否正常。
```

备注遵守以下规则：

- 通常为一至三句话；
- 不直接复制完整命令；
- 不显示 Token、Cookie、Authorization、密码或私钥；
- 在 operation 创建时生成、脱敏并保存；
- 审批页面读取已保存的备注；
- 批准时不重新生成；
- 用户传入的 `note` 或 `operationNote` 不能覆盖系统备注。

普通审批提供：

```text
仅允许一次
允许 5 分钟
拒绝
```

内部 decision 保持 `allow-once`、`allow-always` 和 `deny`。其中 `allow-always` 在本项目中不是永久授权，而是固定五分钟的范围授权。

## 冻结调用与不可重放

需要审批的调用至少保存：

```text
toolName
toolCallId
normalizedArguments
actorId
channelId
sessionId
runId
agentId
canonicalHash
resultRoute
expiresAt
approvalScope
displaySummary
```

同一个审批只能执行一次：

```text
第一次批准 → 原子消费 → 执行冻结调用
再次批准   → ALREADY_CONSUMED → 不再次执行
```

这可以防止重复点击、多个审批入口同时处理、网络重试和旧审批跨任务复用。

## 任务授权

一个任务通常不需要每个工具调用都弹一张卡。

```text
当前任务的第一个普通受保护操作
→ 创建冻结 operation
→ 用户批准
→ 执行原始调用
→ 创建短期 Task Grant
```

Task Grant 绑定 actor、channel、session、runId、Agent、父 Agent、Gateway 启动周期、风险上限、能力范围和过期时间。

新任务、新 runId、新会话、新用户、新频道、Gateway 重启、授权过期或操作超出原范围时，旧授权不能复用。子 Agent 只能继承已保存范围的交集。

## 五分钟范围授权

用户选择“允许 5 分钟”后，系统创建 `SCOPED_TIME_WINDOW`。

时间窗继续绑定 actor、channel、session、runId、Gateway boot、策略版本、有效期和明确 scope。时间窗内每次调用仍经过 Operation Bus、范围检查、风险检查和审计。

以下操作不能被五分钟授权覆盖：

```text
真实支付
最终下单
转账
导出凭据
将秘密发送到外部
修改 Execution Gate 或 Operation Bus
修改审批和 DENY 规则
关闭审计
修改 Integrity
修改 Bootstrap
破坏系统根目录
写入块设备
```

## 固定自动化与 Cron

固定无人值守任务可以使用 Automation Grant，或配置窄范围 Cron 审批豁免。

授权必须绑定：

```text
cronJobId
agentId
runId
自动化定义哈希
允许的工具
允许的能力
允许的资源
允许的目标
必要时绑定精确命令
```

规则不能使用通配 Agent、通配 Job、通配工具、名称模糊匹配或跨任务授权。固定任务被停用或发生实质变化后，旧授权必须失效或重新审批。

## Skill 与 MCP

项目包含 Skill 分析、固定入口识别、Registry、MCP Schema、配置变更和事务执行模块。

Skill 分析器会检查：

```text
SKILL.md
固定入口
Node / Python / Shell 文件
包元数据
依赖和环境变量引用
网络与外部副作用
动态 Shell 和内联执行
文件写入、删除、支付和秘密访问
```

安全的本地 Skill 不需要通过全局放行解释器运行。固定自动化或外部副作用入口可以生成精确 Manifest 和授权；无法安全判断的入口返回 `REVIEW_REQUIRED`。

MCP 配置只接受结构化请求。认证资料应引用私有环境变量，不应把明文 Token、Authorization Header、Cookie、带凭据 URL 或私钥写入聊天、审批卡和公开配置。

公开仓库提供这些通用模块和测试，但不会导入任何生产 MCP、私有 Skill、账号或凭据。

## 快捷安装

### 环境要求

```text
Linux / Ubuntu
单用户 OpenClaw 环境
Node.js 22 或更高
npm
Git
OpenClaw 已安装
Gateway 使用当前用户的 systemd user service
```

安装命令必须由实际运行 OpenClaw Gateway 的普通用户执行，不要使用 `root`。

### 先预览，不修改

```bash
git clone --depth 1 https://github.com/joack-michel/openclaw_plan.git ~/openclaw-execution-gate
cd ~/openclaw-execution-gate
bash install.sh --plan
```

### 应用安装

```bash
bash install.sh --apply
```

也可以直接执行：

```bash
git clone --depth 1 https://github.com/joack-michel/openclaw_plan.git ~/openclaw-execution-gate \
  && cd ~/openclaw-execution-gate \
  && bash install.sh --apply
```

不建议使用 `curl ... | bash`。先取得仓库、检查内容，再运行本地脚本，与本项目禁止“下载后立即执行”的安全原则一致。

安装器会：

```text
检查 Node、npm、Git、OpenClaw 和 systemd
检查核心源码是否完整
运行测试、构建和脱敏验证
读取当前 OpenClaw 配置
生成配置补丁并先执行 dry-run
备份现有配置
添加插件加载路径和 allow 条目
写入最小插件配置
验证配置并重启 Gateway
确认 Gateway 为 active
失败时恢复原配置
```

安装器不会复制生产数据库、凭据、个人 Cron、私有 Skill、个人记忆或生产业务配置，也不会修改 Integrity Hash、Bootstrap 或安全规则本身。

### 可选中文界面补丁

Execution Gate 生成的操作备注本身为中文。部分 OpenClaw 版本的按钮和 Control UI 文案需要额外适配：

```bash
bash install.sh --apply --patch-ui
```

该选项只在当前运行包包含已识别结构时替换用户可见文案，并在修改前保存备份。版本结构不匹配时会停止补丁，不会放宽安全策略。

## 安装后验证

```bash
npm test
npm run build
npm run verify
openclaw config validate
systemctl --user is-active openclaw-gateway.service
```

当前公开回归基线为：

```text
66/66 tests passed
```

涉及运行时或审批链的版本升级，还应真实验证：

```text
安全只读调用 → 直接执行
普通受保护调用 → WAIT_CONFIRM
批准 → 自动执行冻结调用
重复批准 → ALREADY_CONSUMED
新 runId → 不能复用旧任务授权
支付或转账 → FINANCIAL_STEP_UP
凭据导出 → DENY
修改安全核心 → ADMIN_PLANE_REQUIRED
```

测试数量以当前实际执行结果为准，不应长期沿用旧数字。

## 主要文件与职责

### 核心运行时

| 文件 | 作用 |
|---|---|
| `src/index.js` | 插件入口，连接风险判断、审批、任务授权、Cron 豁免和结果回传 |
| `src/operation-bus.js` | 定义 Operation Bus 状态、确认模式、金融边界和结构化操作计划 |
| `src/operation-store.js` | 持久化冻结调用、上下文、哈希、状态和一次性消费记录 |
| `src/grant-store.js` | 保存和校验 Task Grant、Automation Grant 及运行范围 |
| `src/task-approval.js` | 构建任务身份、摘要和允许能力，防止跨任务复用 |
| `src/confirmation-scope.js` | 将审批 scope 绑定到 actor、channel、session 和 runId |
| `src/scoped-time-window.js` | 管理五分钟范围授权、过期和上下文绑定 |
| `src/cron-approval-bypass.js` | 校验精确 Cron 豁免规则、运行身份和去重 |

### 风险与路径判断

| 文件 | 作用 |
|---|---|
| `src/capability-resolver.js` | 将工具调用解析为可判断的业务能力 |
| `src/exec-effect-resolver.js` | 分析 exec 的读写、网络、删除和外部副作用 |
| `src/mutation-effect-resolver.js` | 判断文件和配置 mutation 的实际影响 |
| `src/path-policy.js` | 检查 realpath、符号链接、所有者、权限和可信根 |
| `src/script-identity.js` | 识别固定脚本、解释器、入口和参数身份 |
| `src/destination-identity.js` | 识别消息、网络或外部操作的真实目标 |
| `src/runtime-plane.js` | 区分普通业务操作与安全核心操作 |

### 审批、Skill 与 MCP

| 文件 | 作用 |
|---|---|
| `src/approval-localization.js` | 生成中文操作备注、范围说明和脱敏文案 |
| `src/automation-scope.js` | 构建固定自动化的能力、资源和目标范围 |
| `src/skill-installer.js` | 扫描 Skill、识别入口、内容哈希和危险形状 |
| `src/skill-management.js` | 执行结构化 Skill 安装和卸载计划 |
| `src/skill-registry.js` | 管理需要精确身份和去重约束的 Skill |
| `src/mcp-schema.js` | 定义和校验 MCP 配置请求 |
| `src/mcp-management.js` | 执行 MCP 配置变更、认证引用和备份恢复 |
| `src/mcp-cli-adapter.js` | 将结构化 MCP 请求转换为受限 CLI 操作 |
| `src/install-transaction.js` | 处理安装 staging、检查、提交和恢复 |
| `src/transactional-executor.js` | 统一执行准备、提交、失败和回滚阶段 |

### 配置、测试和发布

| 文件 | 作用 |
|---|---|
| `src/template-config.js` | 提供环境变量化、无生产身份的公开路径与测试配置 |
| `openclaw.plugin.json` | OpenClaw 插件声明和配置 Schema |
| `sql/schema.sql` | Operation、审批、授权、审计和运行状态数据库结构 |
| `install.sh` | 预览、安装、备份、验证和失败恢复入口 |
| `scripts/run-tests.sh` | 在隔离的虚构 OpenClaw 环境运行回归测试 |
| `scripts/verify-public-template.sh` | 检查当前发布树中的秘密、身份和私有文件 |
| `scripts/test-verify-public-template.sh` | 验证脱敏检查器会拒绝负向样本 |
| `test/operation-bus.test.js` | 验证确认模式、金融边界、DENY 和事务状态 |
| `test/transparent-runtime.test.js` | 验证透明审批、中文备注、任务授权和恢复执行 |
| `test/scoped-time-window.test.js` | 验证五分钟授权、身份隔离和不可覆盖边界 |
| `test/cron-approval-bypass.test.js` | 验证固定 Cron 的 Job、Agent、工具和去重边界 |

## 目录结构

```text
openclaw_plan/
├── bin/                         受限 MCP 执行入口
├── config/                      脱敏示例配置
├── docs/                        架构、安全、恢复和定制文档
├── examples/                    脱敏自动化和业务示例
├── policy/                      示例安全策略与风险映射
├── scripts/                     安装、检查、补丁和发布脚本
├── sql/                         SQLite Schema
├── src/                         Execution Gate 通用源码
├── test/                        当前回归测试
├── install.sh                   快捷安装器
├── openclaw.plugin.json         插件声明与配置 Schema
├── package.json                 测试、构建和验证命令
├── SECURITY.md                  安全报告与凭据处理要求
├── SANITIZATION.md              公开仓库脱敏规则
├── CHANGELOG.md                 版本变化记录
└── LICENSE                      MIT License
```

发布版直接包含完整脱敏源码，不再依赖 Base64 归档恢复核心文件。

## 适配版本

当前真实适配基线：

```text
OpenClaw 2026.7.2-beta.4
Node.js 24.x
Ubuntu Linux
systemd user service
SQLite
```

同时保留对以下历史基线的兼容考虑：

```text
OpenClaw 2026.6.11
OpenClaw 2026.7.1-2
```

其他版本不能仅因为插件能够加载，就自动视为完整适配。升级后至少需要重新验证工具暴露、审批创建、冻结调用恢复、防重放、中文界面、runId 隔离、固定 Cron 和金融边界。

## 公开仓库边界

本仓库可以公开：

```text
通用执行门代码
风险判断逻辑
数据库结构
示例配置
测试
安装脚本
脱敏文档
恢复机制
Mock 和虚构测试数据
```

本仓库不包含：

```text
生产 openclaw.json
真实审批数据库
Token、Cookie、Authorization、密码或私钥
设备 identity
真实账号与个人记忆
聊天记录和生产日志
生产 Cron 与 Automation Grant
真实支付接口
私有业务 Skill
生产备份
```

它是安全执行框架和脱敏参考实现，不是生产服务器备份。

## 安全边界

本项目主要降低 AI 误操作、重复执行、不可恢复破坏、高影响外部操作失控、凭据泄露和 Agent 修改安全系统本身的风险。

本项目不提供多租户隔离、企业级身份权限管理、针对恶意本地管理员的防护、任意未知二进制沙箱或对所有第三方 MCP 的安全保证。

秘密不得出现在聊天、Git、审批操作备注、普通日志、测试快照、命令行参数、带凭据 URL 和公开配置中。

发现安全问题时，请查看 [SECURITY.md](SECURITY.md)。

## 验证与历史检查

默认发布验证检查当前工作树和索引：

```bash
npm run verify
```

深度扫描当前本地仓库中所有可恢复 Git 对象：

```bash
bash scripts/verify-public-template.sh --history --skip-tests
```

深度历史扫描可能发现旧提交中的遗留标识。清理 Git 历史属于单独的破坏性仓库维护操作，不应由普通更新脚本自动执行或 force push。

## 文档

- [系统架构](docs/ARCHITECTURE.md)
- [安全模型](docs/SECURITY-MODEL.md)
- [当前公开状态](docs/CURRENT-STATE.md)
- [恢复边界](docs/RECOVERY.md)
- [MCP 管理](docs/MCP-MANAGEMENT.md)
- [Skill 注册](docs/SKILL-REGISTRATION.md)
- [自定义配置](docs/CUSTOMIZATION.md)
- [脱敏规则](SANITIZATION.md)

## 许可证

本项目使用 MIT License。

## 项目原则

```text
普通任务能够顺畅完成；
高影响操作在执行前让用户看懂并确认；
批准后系统自动执行被冻结的原始调用；
重复确认不会重复执行；
所有结果均有真实证据；
安全核心保持隔离。
```
