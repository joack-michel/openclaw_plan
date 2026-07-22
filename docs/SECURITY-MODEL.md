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
- 可信脚本和开发任务；
- Skill 与 MCP 的正常业务调用；
- 风险判断；
- 审批；
- 冻结原始调用；
- 去重和一次性消费；
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

正常业务工具应保持对 Agent 可见，例如：

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

禁止因 adapter 不完整而隐藏全部工具、要求用户 SSH、生成临时脚本让用户手动执行，或在批准后重新生成命令。

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
校验 operation_id
校验 canonicalHash
校验 actor/channel/session/runId
一次性消费
执行已保存的调用
返回原会话
```

同一审批重复批准必须返回：

```text
ALREADY_CONSUMED
```

不同任务即使具有相同 session、工具和参数，只要 `runId` 不同，也不得复用上一任务的 operation 或授权。

自动允许路径不得创建无法消费的 frozen operation，不得长期停留在 `EXECUTING`，也不得让后续调用返回未定义结果。

## 5. 风险分类

风险按实际后果判断，而不是仅按程序名称判断。

```text
普通读取和可信工作区操作
→ 直接允许或按当前运行策略执行

普通开发、测试和构建
→ 低摩擦执行

外部副作用、不可恢复删除、消息发送、配置变更
→ WAIT_CONFIRM

支付、最终下单、转账
→ FINANCIAL_STEP_UP

凭据导出、系统破坏
→ DENY

安全核心修改
→ ADMIN_PLANE_REQUIRED
```

无法完全识别普通业务调用风险时，应优先进入范围受限的 `WAIT_CONFIRM`，而不是隐藏工具或返回笼统的 `OPERATION_BUS_REQUIRED`。

## 6. 宽泛授权边界

10 分钟授权和本次会话授权只能覆盖明确 scope，并绑定 actor、channel、session、run、Gateway boot 和过期时间。

以下行为不能被宽泛授权覆盖：

- 真实支付；
- 最终下单；
- 转账；
- 导出 Token、Cookie、密码或私钥；
- 将秘密发送到外部；
- 修改安全核心；
- 修改确认规则；
- 关闭审计；
- 修改 Integrity 或 Bootstrap；
- 系统根目录破坏；
- 写入块设备。

## 7. 可信路径

可信路径判断不能只检查字符串前缀，还必须考虑：

- realpath；
- `..` 路径逃逸；
- 符号链接逃逸；
- 所有者；
- group/world 可写权限；
- 临时下载目录；
- 设备、Socket 和 FIFO；
- 系统路径覆盖。

不得通过全局放行以下解释器解决兼容问题：

```text
/usr/bin/node *
/usr/bin/python3 *
/bin/bash *
/usr/bin/curl *
```

## 8. 凭据保护

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

## 9. 审批界面

用户可见审批内容使用中文，包括标题、说明、操作备注、校验哈希、操作编号、工具、智能体、审批编号、有效期、审批结果和错误提示。

机器标识保持原文，例如：

```text
WAIT_CONFIRM
CONFIRM_ONCE
SCOPED_TIME_WINDOW
SCOPED_SESSION_APPROVAL
INSTALL_TWO_PHASE
FINANCIAL_STEP_UP
ALREADY_CONSUMED
exec
sha256:...
op_...
```

每张审批卡应显示：

```text
操作备注：
用普通中文说明准备做什么，以及批准后的主要影响。
```

备注应在 operation 创建时生成、脱敏并保存；审批渲染时读取已保存备注，批准时不得重新生成。用户提供的 `params.note` 或类似字段不得覆盖系统生成的备注。

## 10. Registry、Host approvals、Integrity 与 Bootstrap

Registry 和 Host approvals 用于固定自动化、外部副作用、敏感入口和精确业务边界，不应让普通可信工作区操作陷入逐项审批。

Integrity 异常不得导致 L0/L1 全局瘫痪。安全核心的 Integrity Hash 只能由管理面更新。

Bootstrap 正常状态应为：

```text
BOOTSTRAP_COMPLETE
```

出现 staging 时必须比较 staging、正式策略、Integrity Hash、Gateway 实际加载内容和 Git 来源，不得未经比较直接应用或删除。

## 11. 设计不变量

1. 普通可信工作区操作保持低摩擦。
2. 正常工具保持对 Agent 可见。
3. 高影响操作在执行前让用户看懂并确认。
4. 批准后执行冻结的原始调用，不重新解释用户意图。
5. 不同 `runId` 不复用 operation 或任务级授权。
6. 重复批准返回 `ALREADY_CONSUMED`。
7. 支付、最终下单和转账继续逐笔强确认。
8. 凭据导出和系统破坏继续拒绝。
9. 安全核心只能通过管理面修改。
10. 不通过全局放行解释器解决兼容问题。
11. 写入安全状态的管理操作应支持备份、事务和回滚。
12. 公开仓库不得包含生产配置、真实凭据、运行数据库、日志或私有业务数据。

## 12. 修改本模型的条件

只有出现明确证据时才应修改安全模型，例如：

- 普通安全操作被错误拒绝；
- 明确危险操作被错误允许；
- 路径或符号链接逃逸；
- 凭据泄露；
- 高风险操作绕过确认；
- 管理面可被 Agent 或网络调用；
- Integrity 或 Bootstrap 导致系统自锁。

不得因为单个 Skill 或 MCP 配置错误就重构整个 Execution Gate。
