# 更新记录

## 2026-07-24

### 透明审批与工具可用性

- 正常 `exec`、文件、浏览器、`web_fetch` 和已启用 MCP 工具继续对 Agent 可见；
- Operation Bus 作为透明拦截层，不再替代或隐藏正常工具；
- 审批后恢复并执行冻结的原始结构化调用，不重新生成命令，不要求用户手动运行脚本；
- 重复批准继续返回 `ALREADY_CONSUMED`。

### 审批卡交互

- 普通审批卡固定为三个选项：`仅允许一次`、`5分钟内允许所有`、`拒绝`；
- 内部 callback decision 保持 `allow-once`、`allow-always`、`deny`；
- `allow-always` 改为固定 300 秒的 `SCOPED_TIME_WINDOW`，不表示永久授权；
- 时间窗绑定 actor、channel、session、Gateway boot 和 policy version；
- 新增 `/revoke-5min-allow` 主动撤销；
- 删除旧的 10 分钟与会话授权用户文案。

### 操作备注与中文界面

- 审批卡增加通俗中文“操作备注”，说明操作用途和批准后的主要影响；
- 备注在 operation 创建时生成、脱敏并保存，批准时不得重新生成；
- 用户传入的 `note`、`operationNote` 等字段不能覆盖系统备注；
- 用户可见字段和按钮使用中文，机器枚举、Hash、operation ID 与 callback data 保持原文。

### 高风险边界

- 金融审批卡只显示 `确认本次交易` 与 `拒绝`；
- 真实支付、最终下单和转账不能被 5 分钟授权覆盖；
- 秘密导出、安全核心修改、系统破坏和块设备操作不受宽泛授权覆盖。

### 验证

- `npm test` 通过；
- `npm run build` 通过；
- `git diff --check` 通过；
- Gateway 已重启并确认 execution-gate 加载，服务为 active；
- 自动化覆盖范围匹配、越界、撤销、过期和 Gateway 重启绑定；
- 公开仓库继续只同步脱敏通用设计，不包含生产凭据、运行数据库和私有业务数据。

### 适配版本

```text
Node.js 22.x
OpenClaw 2026.6.11
OpenClaw 2026.7.1-2
Linux
SQLite
```

---

## 2026-07-23

### 安全模型与审批链文档

- 更新长期安全模型，明确 Gateway、Execution Gate 与 Operation Bus 的业务面职责；
- 明确正常 `exec`、文件、浏览器和 MCP 工具应保持对 Agent 可见；
- 明确 Operation Bus 是透明拦截层，不是正常工具的替代品；
- 补充冻结原始调用、`runId` 绑定、一次性消费和 `ALREADY_CONSUMED` 不变量；
- 明确支付、最终下单和转账不受宽泛授权覆盖；
- 补充中文审批界面与脱敏“操作备注”要求；
- 新增公开仓库当前状态文档，区分公开模板状态与生产运行时验收；
- 本次只同步脱敏文档，不声称生产 Gateway 或真实审批链已完成验收。

---

## 2026-07-19

### 结构化 MCP 管理

- 新增 `mcp_manage` 通用工具；
- `list/status/show/doctor/probe` 按 L0 读取处理；
- 配置变更复用 L2 `WAIT_CONFIRM`、冻结参数哈希和一次性消费；
- 明文凭据、敏感 Header、认证 URL 和任意命令直接拒绝；
- stdio 仅接受固定 executable 与结构化 argv；
- 本地管理 CLI 与聊天工具复用同一验证和执行实现；
- 公开模板只包含占位符、环境变量名称和脱敏示例。

### 发布安全

- 增加地址、账号、金额、账单和公用事业数据检查；
- 生产日志、运行记录、个人身份、真实端点和凭据未进入公开仓库；
- MCP 示例使用保留域名或占位符，不包含可用认证信息。

---

## 2026-07-17

### 安全模型 v2

- 将公开模板补充为 L0/L1/L2/L3 四级风险模型；
- 明确 `ALLOW`、`CONFIRM`、`DENY` 与 `CONFIG_ERROR` 的边界；
- 增加 L0/L1 exec 的 Host approvals 预检说明；
- 明确 `allowlist miss` 不得进入确认循环；
- 明确失败请求不得写入成功去重状态；
- 保留未知 Shell、解释器、脚本和未登记 executable 的拒绝边界；
- 补充 ACTIVE Grant 额度和周期约束；
- 保持完整性哈希异常为 `WARN_ONLY`。

### 本地恢复能力

- 补充本地恢复 CLI 的设计与命令范围；
- 增加 dry-run、自动备份、审计和撤销要求；
- 明确恢复 CLI 仅限服务器本地受信任用户，不监听网络；
- 补充权限自锁的恢复顺序；
- 禁止通过全局放开 Shell 或扩大 Grant 解除自锁。

### 事务式 Skill 注册

- 新增 `execution-manifest.json` 驱动的 Skill Registry；
- 新增 `skill inspect/register/update/verify/remove/list`；
- 注册、更新和注销采用原子事务、互斥锁、自动备份和失败回滚；
- 重复注册保持幂等，不产生无意义写入；
- Gate 改为按 Registry 精确匹配 executable、argv、cwd、作用域、超时与环境；
- 普通业务 Skill 不再需要逐个硬编码进 resolver；
- Host approvals 自动同步并在 Gateway 重启后验证；
- 更新时自动清理旧 approval；
- 未登记入口继续返回 `CONFIG_ERROR`。

### 迁移与验证

- 现有固定业务 Skill 完成注册表精确匹配和作用域核验；
- REM 已通过真实 Gateway E2E；
- 福利任务编排能力完成配置核验，未扩大 Grant；
- 无外部副作用的烟测 Skill 完成注册、幂等验证和注销；
- Gateway 重启后保持可用。

### 公开仓库精简

- 删除私有业务专属 Fast Path 源码和配置示例；
- 删除对应环境变量、插件配置、风险特例和文档章节；
- 公开仓库只保留通用 Execution Gate、Skill 注册、恢复和安全治理能力；
- 私有业务模块继续只保存在用户自己的生产环境中。

### 文档

- 新增 `docs/SKILL-REGISTRATION.md`；
- 更新安全、恢复和验证文档；
- 更新 `SECURITY.md`。

### 公开与脱敏

- 公开仓库只同步脱敏通用模板和文档；
- 生产 Registry、真实 approvals、身份范围、私有业务参数、日志、数据库和备份不进入仓库。

<!-- 用途：记录公开模板的重要功能与安全边界更新。 -->