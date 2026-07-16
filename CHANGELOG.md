# 更新记录

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

- 门禁类能力已从硬编码 Fast Path 迁移为注册表精确匹配；
- REM 已通过真实 Gateway E2E，仅一次 exec，发现 7 个文件；
- 福利任务编排能力完成配置核验，未扩大 Grant；
- 无外部副作用的烟测 Skill 完成注册、幂等验证和注销；
- 测试更新为 `102 passed, 0 failed`；
- Gateway 重启后保持 `active`。

### 文档

- 新增 `docs/SKILL-REGISTRATION.md`；
- 新增 `docs/UPDATE-2026-07-17.md`；
- 更新 `docs/SECURITY-MODEL.md`；
- 更新 `docs/RECOVERY.md`；
- 更新 `docs/VALIDATION-2026-07.md`；
- 更新 `SECURITY.md`。

### 公开与脱敏

- 公开仓库只同步脱敏模板和文档；
- 生产 Registry、真实 approvals、身份范围、门禁参数、Grant ID、日志、数据库和备份不进入仓库；
- 本地事务式注册实现对应提交：`922465f feat: add transactional skill registration`。

<!-- 用途：记录公开模板的重要功能与安全边界更新。 -->
