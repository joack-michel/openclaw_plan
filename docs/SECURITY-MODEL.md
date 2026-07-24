# Execution Gate 安全模型

## 1. 文档目的

本文说明 OpenClaw Execution Gate 公开模板采用的长期安全模型。

项目主要降低以下风险：

- 模型误操作；
- 重复执行；
- 高影响外部操作；
- 不可恢复的数据破坏；
- 凭据泄露；
- Agent 修改安全系统本身。

设计目标：

```text
低摩擦
可恢复
按实际后果判断风险
用户负责审批，系统负责执行
```

本模板面向单用户自用场景，不默认扩展为多租户、零信任或企业级权限平台。

## 2. 执行平面

系统分为业务面和管理面。

### 2.1 业务面

业务面由 Gateway、Execution Gate 和 Operation Bus 组成，负责：

- 普通工作区读写；
- 脚本、测试和开发任务；
- Skill 与 MCP 的正常业务调用；
- 风险判断；
- 审批；
- 冻结原始调用；
- 去重和一次性消费；
- 范围授权；
- 审计与结果返回。

### 2.2 管理面

本地管理入口为：

```text
openclaw-admin
```

只有真正修改安全核心时，才应返回：

```text
ADMIN_PLANE_REQUIRED
```

例如：

- 修改 Execution Gate 或 Operation Bus 核心规则；
- 修改审批、授权或 DENY 规则；
- 修改 Registry、Host approvals 的核心结构；
- 修改 Integrity Hash；
- 修改 Bootstrap；
- 关闭审计或安全系统；
- 修改管理面自身。

普通业务操作不得错误归类为管理面，包括测试、构建、普通文件修改、Skill/MCP 管理、业务依赖安装和正常 Gateway reload。

## 3. 工具与透明审批

正常业务工具必须保持对 Agent 可见，例如：

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

Operation Bus 是透明拦截层，不是正常工具的替代品。正确流程：

```text
Agent 调用正常工具
→ Gateway 捕获结构化调用
→ Operation Bus 判断风险
→ 必要时冻结原始调用并返回 WAIT_CONFIRM
→ 用户批准
→ 恢复并执行被冻结的完全相同调用
→ 将结果返回原会话
```

禁止：

- 因 adapter 不完整而隐藏全部工具；
- 普通调用直接返回笼统的 `OPERATION_BUS_REQUIRED`；
- 要求用户 SSH；
- 生成临时脚本让用户手动执行；
- 批准后重新生成命令；
- 批准后重新解析用户原话；
- 用另一个动作替换被冻结调用。

## 4. 审批链不变量

需要审批的调用必须冻结并保存至少以下上下文：

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
校验 operationId
校验 canonicalHash
校验 actor/channel/session/runId
原子一次性消费
执行已保存的原始调用
返回原会话
```

同一审批重复批准必须返回：

```text
ALREADY_CONSUMED
```

不同任务即使 session、工具和参数相同，只要 `runId` 不同，也不得复用上一任务的 operation。

自动允许路径不得创建无法消费的 frozen operation，不得长期停留在 `EXECUTING`，也不得让后续调用返回未定义结果。

## 5. 普通审批卡

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

其中 `allow-always` 不表示永久允许，而是创建：

```text
SCOPED_TIME_WINDOW
TTL = 300 秒
```

时间窗必须绑定：

```text
actorId
channelId
sessionId
Gateway bootId
policyVersion
createdAt
expiresAt
scope
```

授权可通过以下命令主动撤销：

```text
/revoke-5min-allow
```

时间窗内的每次调用仍必须经过 Operation Bus、范围检查和审计。

## 6. 风险分类

风险按实际后果判断，而不是仅按程序名称判断。

```text
纯内存分析、计划生成和 Hash 计算
→ ALLOW_INTERNAL

普通工具调用
→ 无有效授权时 WAIT_CONFIRM
→ 命中有效 5 分钟范围授权时执行

Skill、插件和依赖安装
→ INSTALL_TWO_PHASE

支付、最终下单、转账
→ FINANCIAL_STEP_UP

凭据导出、系统破坏、块设备写入
→ DENY

安全核心修改
→ ADMIN_PLANE_REQUIRED
```

无法完全识别普通业务调用风险时，应优先进入范围受限的 `WAIT_CONFIRM`，而不是隐藏工具。

## 7. 5 分钟授权边界

“5分钟内允许所有”中的“所有”仅指当前绑定上下文与 scope 内的普通业务操作，不表示关闭安全模块。

可覆盖的普通操作可以包括：

- `exec`；
- 文件读取、写入和编辑；
- `web_fetch`；
- 普通浏览器操作；
- 普通 MCP 调用；
- 测试和构建；
- 普通业务配置；
- Skill/MCP 安装的检查和准备阶段。

以下行为不能被 5 分钟授权覆盖：

- 真实支付；
- 最终下单；
- 转账；
- 导出 Token、Cookie、密码或私钥；
- 将秘密发送到外部；
- 修改安全核心；
- 修改确认或授权规则；
- 关闭审计；
- 修改 Integrity 或 Bootstrap；
- 系统根目录破坏；
- 写入块设备。

授权在以下情况失效：

- 300 秒到期；
- actor、channel 或 session 变化；
- Gateway 重启；
- policy version 变化；
- 用户主动撤销。

## 8. 金融强确认

真实支付、最终下单和转账继续逐笔强确认。

金融审批卡只显示：

```text
确认本次交易
拒绝
```

金融确认必须绑定操作编号、规范化参数和 `canonicalHash`，并冻结商户或收款方、商品、数量、金额、币种、费用、订单号和支付方式摘要。

5 分钟授权不得覆盖金融操作。

## 9. Skill、插件与依赖安装

安装类操作使用：

```text
INSTALL_TWO_PHASE
```

流程：

```text
第一次确认
→ 在 staging 下载、解压、检查和生成报告
→ 不修改正式目录和正式配置

第二次确认
→ 校验 staging 与计划 Hash
→ 写入正式目录
→ 应用 MCP / 插件配置事务
→ reload Gateway
→ discovery / doctor / probe
→ 成功提交或失败回滚
```

普通 Skill 与带 MCP 的 Skill使用同一流程。不得要求用户手动运行终端脚本。

## 10. 可信路径与执行安全

路径判断不能只检查字符串前缀，还必须考虑：

- realpath；
- `..` 路径逃逸；
- 符号链接逃逸；
- 所有者；
- group/world 可写权限；
- 临时下载目录；
- 设备、Socket 和 FIFO；
- 系统路径覆盖。

结构化执行应使用固定 argv、超时、输出限制和脱敏审计。

不得通过全局放行以下解释器解决兼容问题：

```text
/usr/bin/node *
/usr/bin/python3 *
/bin/bash *
/usr/bin/curl *
```

## 11. 凭据保护

任何真实凭据不得出现在：

```text
聊天
Git
普通日志
公开配置
命令行参数
测试快照
审批操作备注
```

公开模板仅允许环境变量名称、保留域名和不可用占位符。诊断和审批输出必须主动脱敏 Token、Cookie、Authorization、密码、私钥、带凭据 URL 和敏感 Header。

## 12. 审批界面

用户可见审批内容使用中文，包括：

```text
需要插件审批
标题
说明
操作备注
校验哈希
操作编号
工具
智能体
审批编号
有效期
审批结果
错误提示
```

机器标识保持原文，例如：

```text
WAIT_CONFIRM
CONFIRM_ONCE
SCOPED_TIME_WINDOW
INSTALL_TWO_PHASE
FINANCIAL_STEP_UP
ALREADY_CONSUMED
exec
sha256:...
op_...
plugin:...
allow-once
allow-always
deny
```

每张审批卡必须显示：

```text
操作备注：
用普通中文说明准备做什么，以及批准后的主要影响。
```

备注要求：

- 通常为 1～3 句话；
- 不直接复制完整命令；
- 在 operation 创建时生成、脱敏并保存；
- 审批渲染时读取已保存备注；
- 批准时不得重新生成；
- 用户提供的 `params.note`、`params.operationNote` 等字段不得覆盖系统备注；
- 同一字段不得被内外 formatter 重复渲染。

## 13. Registry、Host approvals、Integrity 与 Bootstrap

Registry 和 Host approvals 可以保留用于固定自动化、外部副作用、敏感入口和精确业务边界，但不得隐藏普通工具或让普通 Skill、脚本陷入逐项许可证模式。

Integrity 异常不得导致所有普通工具全局瘫痪。安全核心的 Integrity Hash 只能由管理面更新。

Bootstrap 正常状态应为：

```text
BOOTSTRAP_COMPLETE
```

出现 staging 时必须比较 staging、正式策略、Integrity Hash、Gateway 实际加载内容和 Git 来源，不得未经比较直接应用或删除。

## 14. 设计不变量

1. 正常工具保持对 Agent 可见。
2. Operation Bus 是透明安全拦截层。
3. 高影响操作执行前让用户看懂并确认。
4. 批准后执行冻结的原始调用，不重新解释用户意图。
5. 不同 `runId` 不复用 operation。
6. 重复批准返回 `ALREADY_CONSUMED`。
7. 普通审批卡固定为“仅允许一次 / 5分钟内允许所有 / 拒绝”。
8. 5 分钟授权固定为 300 秒并绑定运行上下文。
9. 支付、最终下单和转账继续逐笔强确认。
10. 凭据导出、系统破坏和块设备写入继续拒绝。
11. 安全核心只能通过管理面修改。
12. 不通过全局放行解释器解决兼容问题。
13. 写入安全状态的管理操作应支持备份、事务和回滚。
14. 公开仓库不得包含生产配置、真实凭据、运行数据库、日志或私有业务数据。

## 15. 适配版本

```text
Node.js 22.x
OpenClaw 2026.6.11
OpenClaw 2026.7.1-2
Linux
SQLite
```

`2026.6.11` 保留原生审批 schema 兼容，`2026.7.1-2` 为当前透明审批、中文审批卡和 5 分钟授权的适配基线。

## 16. 修改本模型的条件

只有出现明确证据时才应修改安全模型，例如：

- 普通安全操作被错误拒绝；
- 正常工具被错误隐藏；
- 明确危险操作被错误允许；
- 路径或符号链接逃逸；
- 凭据泄露；
- 高风险操作绕过确认；
- 管理面可被 Agent 或网络调用；
- Integrity 或 Bootstrap 导致系统自锁。

不得因为单个 Skill 或 MCP 配置错误就重构整个 Execution Gate。