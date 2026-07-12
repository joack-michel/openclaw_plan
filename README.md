# OpenClaw 执行门模板

一个面向 OpenClaw 的低摩擦执行安全模板。

它的目标不是让所有操作都需要审批，而是在尽量不影响正常使用的前提下，重点防止：

- 模型误操作；
- 重复执行；
- 自动化越权；
- 误下单和误支付；
- 向错误对象发送消息；
- 删除重要数据；
- 修改关键安全配置；
- 因局部异常导致整个系统不可用。

本仓库已进行脱敏处理，不包含生产数据库、真实 Token、个人地址、Telegram ID、账号信息、个人记忆、真实门禁配置或历史运行状态。

---

## 项目定位

OpenClaw 可以调用文件、命令、自动化、消息、订单、支付等工具。

如果所有工具都直接执行，可能出现：

```text
模型理解错误
→ 调用了错误工具
→ 产生真实副作用
```

如果所有工具都要求确认，又会出现：

```text
普通读取
普通写文件
查询 Cron
读取记忆
运行既有自动化
→ 全部被拦截
→ 系统难以正常使用
```

本项目采用三类决策：

```text
ALLOW
CONFIRM
DENY
```

核心思想是：

```text
普通操作直接执行
真正高风险操作要求确认
明确破坏操作直接拒绝
```

---

# 一、风险模型

## ALLOW：直接允许

以下操作通常可以直接执行：

```text
读取普通 Workspace 文件
读取日志和状态
读取 MEMORY、topics、learnings
普通 Workspace 写入
修改普通 Skill
查询 Cron
查询 Automation Grant
执行已有低风险自动化
向用户本人发送通知
查询优惠券
领取优惠券
固定范围内的任务状态维护
```

这些操作仍然受到路径、Grant、资源范围和固定入口的限制。

直接允许不代表无限权限。

---

## CONFIRM：需要用户确认

以下操作通常需要用户明确确认：

```text
真实下单
真实支付
转账
购买商品
开通会员
自动续费
向第三方发送消息
向群组发送消息
修改 OpenClaw 核心配置
修改 Execution Gate
修改安全策略
修改认证信息
读取敏感凭据
扩大 Automation Grant
修改自动化固定执行入口
执行未知高影响命令
删除重要文件
批量删除数据
```

默认确认方式：

```text
确认
```

存在多个待确认操作时：

```text
确认 1
确认 2
```

不需要复制 operation ID，也不需要使用复杂审批命令。

---

## DENY：直接拒绝

以下明确破坏性行为直接拒绝：

```text
格式化磁盘
删除根目录
删除大范围系统目录
主动泄露 Token、密码或 Cookie
故意绕过用户拒绝
故意绕过支付暂停
删除审计数据库以隐藏行为
执行明显的系统自毁命令
```

未知操作不会一律拒绝。

处理原则：

```text
普通未知操作
→ 根据实际 Effect 判断

未知高影响操作
→ CONFIRM

明确破坏操作
→ DENY
```

---

# 二、确认机制

## 真实确认流程

正确流程：

```text
Agent 调用受保护工具
↓
Execution Gate 识别风险
↓
创建 WAIT_CONFIRM operation
↓
向用户发送标准确认提示
↓
用户回复“确认”
↓
operation 进入 CONFIRMED
↓
执行工具
↓
记录 SUCCEEDED 或 FAILED
```

模型只在聊天中说：

```text
请回复确认
```

并不会自动产生真实审批。

只有 Execution Gate 在数据库中创建了对应的待确认 operation，确认才有效。

---

## 确认绑定范围

每个确认会绑定：

```text
用户或频道范围
工具名称
参数哈希
operation identity
```

因此：

```text
确认 exec A
```

不能自动授权：

```text
write B
edit B
另一个参数不同的 exec
```

---

## 确认有效期

默认有效期：

```text
15 分钟
```

超过有效期后：

```text
operation 过期
不能再次执行
不能复用
不能作为新的确认依据
```

历史记录可以继续保留用于审计。

---

## 多个待确认操作

存在多个待确认操作时，Execution Gate 会返回类似：

```text
有 3 个待确认操作：

1. 执行命令：……
2. 创建订单
3. 修改核心配置

请回复：
确认 1
确认 2
确认 3
```

只执行用户选择的那一项。

---

# 三、Automation Grant

Automation Grant 用于限制自动化任务的真实权限范围。

每个 Grant 可以绑定：

```text
jobId
agentId
Tool
Capability
Resource
固定命令
通知目标
运行上下文
```

例如一个优惠券任务可以拥有：

```text
查询优惠券
领取优惠券
发送本人通知
```

但不能因为属于同一个 Agent，就自动获得：

```text
下单
支付
修改系统配置
向第三方发消息
```

---

## 已有自动化

已经启用且具有 ACTIVE Grant 的低风险自动化，可以在原范围内直接运行。

例如：

```text
定时扫描记忆
查询优惠券
领取优惠券
执行签到
发送本人汇总
```

不应该每次运行都要求确认。

---

## 手动触发

用户手动触发已有任务时，可以复用原 Grant：

```text
手动运行一次 REM
手动运行一次福利任务
手动触发一次优惠券领取
```

复用时必须保持：

```text
原 jobId
原 grantId
原固定命令
原资源范围
原通知目标
```

手动触发不能扩大权限。

---

## 自动化越权

以下情况视为越权：

```text
领券任务尝试支付
只读任务尝试修改安全策略
本人通知任务尝试向第三方发消息
固定脚本被替换为其他命令
任务访问未授权资源
```

越权操作只阻止当前调用，不应导致整个自动化系统锁死。

---

# 四、REM 记忆扫描

本模板支持 REM 类记忆整理任务。

允许读取：

```text
MEMORY.md
memory/**/*.md
topics/**/*.md
.learnings/**/*.md
```

允许在原 Grant 范围内更新：

```text
记忆摘要
扫描状态
索引
学习记录
经验记录
任务状态
```

---

## 单文件失败隔离

REM 扫描时，一个文件失败不应终止整个任务。

处理流程：

```text
读取文件 A
→ 成功

读取文件 B
→ 不存在
→ 记录 MISSING

读取文件 C
→ 成功

继续完成剩余扫描
→ 生成最终汇总
```

状态可以包括：

```text
SUCCESS
MISSING
READ_FAILED
PARSE_FAILED
SKIPPED
```

---

## 凭据保护

REM 的记忆读取权限不能扩大到：

```text
.env
*.pem
*.key
credentials*
secrets*
token*
cookies*
auth*
SSH 私钥
API Key 配置
其他用户目录
未授权 Agent 目录
```

符号链接指向 Workspace 外部时，也不能继承普通记忆读取权限。

---

# 五、福利任务编排

本模板支持将多个低风险福利任务交给一个父级 Agent 编排。

示例：

```text
福利编排 Agent
├── 平台 A 优惠券
├── 平台 B 优惠券
├── 签到任务
├── 免费权益任务
└── 结果汇总
```

父级 Agent 只负责：

```text
调度
编排
失败隔离
结果汇总
本人通知
```

不得获得无限权限。

---

## 可直接执行

```text
查询优惠券
领取优惠券
签到
领取免费权益
查询执行结果
向本人发送汇总
```

---

## 仍需确认

```text
下单
支付
购买
开通会员
自动续费
第三方通知
```

---

## 平台隔离

不同平台必须使用独立的：

```text
Tool
Capability
Grant
固定入口
去重状态
```

不能因为两个平台都属于“外卖”或“优惠券”，就混为同一个能力。

---

# 六、优惠券、订单和支付

推荐能力拆分：

```text
QUERY_COUPON
CLAIM_COUPON
ORDER
PAYMENT
```

风险策略：

| 操作 | 默认决策 |
|---|---|
| 查询优惠券 | ALLOW |
| 领取优惠券 | ALLOW |
| 创建订单 | CONFIRM |
| 支付 | CONFIRM |

---

## 领取去重

领取优惠券可以使用短时间去重：

```text
同一张券
60 秒内
不重复领取
```

领取失败时不自动重试，避免重复调用。

---

## 防止重复下单

真实下单成功后，可以暂停下单或支付能力一段时间，例如：

```text
暂停 1 小时
```

暂停期间：

```text
查询正常
领券正常
订单查询正常
新下单被拒绝
新支付被拒绝
```

用户可以通过明确指令提前恢复。

---

# 七、门禁示例

本仓库只提供通用门禁接口示例。

默认配置：

```text
enabled = false
```

示例配置：

```json
{
  "enabled": false,
  "provider": "example",
  "community": "<COMMUNITY_NAME>",
  "building": "<BUILDING_ID>",
  "unit": "<UNIT_ID>",
  "scope": "<ACCESS_CONTROL_SCOPE>",
  "command": "<ACCESS_CONTROL_COMMAND>"
}
```

仓库中不包含：

```text
真实小区名称
真实楼栋
真实单元
真实门禁接口
真实设备 ID
真实门禁 Token
真实执行命令
```

启用门禁前，必须在私有配置中明确设置：

```dotenv
ACCESS_CONTROL_ENABLED=true
```

并提供精确的：

```text
scope
command
provider
```

不应根据普通文本中出现：

```text
门禁
开门
door
```

就触发门禁 Fast Path。

---

# 八、完整性监控

本模板使用：

```text
WARN_ONLY
```

策略处理完整性哈希不一致。

即：

```text
发现 hash mismatch
→ 写入审计日志
→ 必要时通知用户
→ 系统继续运行
```

不会因为某个文件哈希变化，就把所有：

```text
read
write
exec
Automation
REM
```

全部锁死。

完整性监控的目的主要是发现异常，不是制造自锁。

---

# 九、目录结构

```text
openclaw_plan/
├── src/                         Execution Gate 源码
├── test/                        测试
├── sql/                         SQLite Schema
├── scripts/                     安装、恢复和脱敏检查脚本
├── config/                      示例配置
├── policy/                      示例安全策略
├── examples/                    REM、福利任务和门禁示例
├── docs/                        架构、恢复和安全文档
├── archive/                     较大源码与测试的脱敏归档
├── .env.example                 环境变量示例
├── .gitignore
├── openclaw.plugin.json
├── package.json
├── README.md
├── SECURITY.md
├── SANITIZATION.md
└── LICENSE
```

---

# 十、安装

## 环境要求

建议：

```text
Node.js >= 22
OpenClaw >= 2026.6.11
Linux 或兼容 Shell 环境
SQLite
```

---

## 克隆仓库

```bash
git clone <REPOSITORY_URL> ~/openclaw-execution-gate-template
cd ~/openclaw-execution-gate-template
```

安装依赖：

```bash
npm install
```

---

## 恢复归档中的源码和测试

部分较大的源码和测试文件保存在：

```text
archive/remaining-files.tgz.b64
```

运行：

```bash
bash scripts/restore-remaining-files.sh
```

该脚本会将文件还原到：

```text
src/
test/
```

---

## 创建私有覆盖层

```bash
mkdir -p private-overlay
cp .env.example private-overlay/.env
```

编辑：

```text
private-overlay/.env
```

填写真实配置。

私有覆盖层已经被 `.gitignore` 忽略，不应提交到仓库。

---

## 安装到独立运行目录

不要直接把 Git 模板目录当作生产运行目录。

推荐：

```bash
bash scripts/install-template.sh ~/openclaw-execution-gate-runtime
```

应用私有配置：

```bash
bash scripts/apply-private-overlay.sh ~/openclaw-execution-gate-runtime
```

目录建议：

```text
~/openclaw-execution-gate-template/
→ 公开 Git 模板

~/openclaw-execution-gate-template/private-overlay/
→ 本地私有配置

~/openclaw-execution-gate-runtime/
→ 实际运行目录
```

---

# 十一、配置

示例环境变量：

```dotenv
OPENCLAW_HOME=~/.openclaw
OPENCLAW_WORKSPACE=~/.openclaw/workspace
EXECUTION_GATE_HOME=~/openclaw-execution-gate
EXECUTION_GATE_DB=~/.openclaw/state/execution-gate.sqlite

TELEGRAM_USER_ID=<TELEGRAM_USER_ID>
TELEGRAM_BOT_TOKEN=<TELEGRAM_BOT_TOKEN>

MCD_MCP_TOKEN=<MCD_MCP_TOKEN>
MEITUAN_TOKEN=<MEITUAN_TOKEN>

BENEFITS_AGENT_ID=benefits-orchestrator
REM_AGENT_ID=memory-agent
MEITUAN_AGENT_ID=commerce-agent
MCDONALDS_AGENT_ID=commerce-agent

ACCESS_CONTROL_ENABLED=false
ACCESS_CONTROL_SCOPE=<ACCESS_CONTROL_SCOPE>
ACCESS_CONTROL_COMMAND=<ACCESS_CONTROL_COMMAND>
```

公开仓库只保留环境变量名称和占位符，不应填写真实值。

---

# 十二、初始化数据库

使用：

```text
sql/schema.sql
```

初始化新的空数据库。

示例：

```bash
mkdir -p ~/.openclaw/state

sqlite3 ~/.openclaw/state/execution-gate.sqlite \
  < sql/schema.sql
```

公开模板不会恢复：

```text
历史 operation
历史 Grant
历史 Cron 状态
历史运行结果
```

这些数据应由新实例重新生成，或从用户自己的加密私有备份恢复。

---

# 十三、测试和构建

运行测试：

```bash
npm test
```

检查源码语法：

```bash
npm run build
```

运行脱敏验证：

```bash
npm run verify
```

---

## 发布目录验证

对于不含 `.git` 的干净导出目录：

```bash
bash scripts/verify-public-template.sh --release
```

发布模式会检查：

```text
private-overlay
.env
数据库
日志
备份
私钥
Token
敏感路径
个人标识
Git 历史残留
```

---

# 十四、恢复流程

基本恢复步骤：

1. 克隆公开模板；
2. 恢复归档中的源码和测试；
3. 安装依赖；
4. 创建私有覆盖层；
5. 填写真实环境变量；
6. 安装到独立运行目录；
7. 应用私有配置；
8. 初始化新的空数据库；
9. 导入经过复核的自动化配置；
10. 启动 OpenClaw Gateway；
11. 运行测试和构建；
12. 手动验证高风险确认流程。

公开模板无法恢复：

```text
真实 Token
真实地址
真实账号
个人记忆
数据库历史
生产 Cron ID
生产 Grant ID
```

这些内容必须来自单独保存的私有加密备份。

---

# 十五、私有备份建议

建议在仓库外保存：

```text
真实 .env
Agent 配置
Automation 配置
Grant 配置
门禁配置
数据库
Token
必要的个人记忆
```

例如：

```text
~/private-backups/
```

建议对私有备份进行加密。

不要把私有备份放入本仓库目录。

---

# 十六、脱敏原则

本仓库使用允许列表导出。

默认排除：

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
真实地址
真实账号 ID
```

公开表示方式：

| 信息类别 | 占位符 |
|---|---|
| 姓名 | `<USER_NAME>` |
| 邮箱 | `<USER_EMAIL>` |
| Telegram ID | `<TELEGRAM_USER_ID>` |
| Bot 用户名 | `<BOT_USERNAME>` |
| Job ID | `<JOB_ID>` |
| Grant ID | `<GRANT_ID>` |
| Operation ID | `<OPERATION_ID>` |
| 服务器地址 | `<SERVER_HOST>` |
| IP | `<SERVER_IP>` |
| 域名 | `<DOMAIN>` |
| 小区 | `<COMMUNITY_NAME>` |
| 楼栋 | `<BUILDING_ID>` |
| 门禁 Scope | `<ACCESS_CONTROL_SCOPE>` |
| Token | 对应环境变量占位符 |

---

# 十七、已知限制

## 不是完整生产备份

本仓库只能恢复：

```text
代码
策略框架
数据库结构
示例配置
安装方式
测试
```

不能单独恢复用户的真实实例。

---

## 大文件使用归档存储

部分源码和测试文件使用：

```text
archive/remaining-files.tgz.b64
```

保存。

克隆后需要先运行恢复脚本，才能得到完整源码树。

---

## 平台实现为模板或 Mock

本公开版本不会附带：

```text
真实平台 Token
真实 Cookie
真实账号
真实下单接口
真实支付接口
真实门禁接口
```

使用者需要自行实现 Provider 或在私有配置中接入。

---

## 环境兼容性

模板以：

```text
OpenClaw >= 2026.6.11
Node.js >= 22
```

为主要参考环境。

未来 OpenClaw Hook、Plugin SDK 或 Tool 命名发生变化时，可能需要调整。

---

# 十八、安全建议

部署前至少确认：

```text
Telegram Bot 已设置白名单
没有不必要的公网端口
数据库文件权限正确
private-overlay 未被 Git 跟踪
真实 Token 未写入代码
高风险 Tool 仍处于 CONFIRM
明显破坏操作仍处于 DENY
```

不要为了减少确认，把以下能力加入低风险直通：

```text
支付
转账
任意 Shell
任意第三方消息
任意系统配置修改
任意凭据读取
```

---

# 十九、问题反馈

提交 Issue 时不要附带：

```text
Token
Cookie
密码
数据库
聊天日志
个人记忆
地址
门禁信息
订单号
真实账号 ID
```

可以提供：

```text
脱敏后的错误日志
错误类型
相关文件路径
复现步骤
预期结果
实际结果
```

---

# 二十、许可证

本项目使用 MIT License。

```text
Copyright (c) 2026
OpenClaw Execution Gate Contributors
```

代码可以在遵守许可证的前提下使用、修改、分发和二次开发。

<!-- 用途：项目说明、安装指南、安全模型和恢复流程。 -->
