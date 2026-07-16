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

### 恢复能力

- 补充本地恢复 CLI 的设计与命令范围；
- 增加 dry-run、自动备份、审计和撤销要求；
- 明确恢复 CLI 仅限服务器本地受信任用户，不监听网络；
- 补充权限自锁的恢复顺序；
- 禁止通过全局放开 Shell 或扩大 Grant 解除自锁。

### 验收记录

- 新增 `docs/VALIDATION-2026-07.md`；
- 记录 REM 真实扫描、精确门禁 approvals、恢复 CLI 和测试结果；
- 真实身份、路径、Grant ID、门禁参数、日志和外部平台账号均未进入公开仓库。

### 文档

- 更新 `docs/SECURITY-MODEL.md`；
- 更新 `docs/RECOVERY.md`；
- 更新 `SECURITY.md`。

<!-- 用途：记录公开模板的重要功能与安全边界更新。 -->
