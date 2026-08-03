# 2026 年 7 月风险分级改造验收记录

本文件记录一次脱敏后的实现与验证结果，用于说明模板设计经过了哪些类型的真实验证。

它不是生产实例备份，不包含真实 Token、Telegram ID、Grant ID、运行日志、服务器生产路径、私有业务模块或外部平台账号。

## 状态

```text
PARTIAL
```

核心安全改造、事务式 Skill 注册、本地恢复能力和 REM E2E 已完成；部分外部平台任务和完整恢复演练仍需在合法条件下验证。

## 已验证

### 风险分流

- 原生 Workspace、Skill、Agent 和普通日志读取按 L0 处理；
- 秘密、认证路径和符号链接逃逸继续受保护；
- 已登记固定业务入口按 L1 处理；
- 未知 Shell、解释器、脚本和未登记 executable 返回 `CONFIG_ERROR`；
- `CONFIG_ERROR` 不创建 `WAIT_CONFIRM`，不写入成功去重状态；
- L0/L1 exec 在执行前完成 Host approvals 预检；
- 完整性哈希异常采用 `WARN_ONLY`，不会阻断诊断读取。

### 事务式 Skill 注册

已完成：

```text
skill inspect
skill register
skill update
skill verify
skill remove
skill list
```

注册系统具备：

- 默认 dry-run；
- 原子事务；
- 自动备份和失败回滚；
- 重复注册幂等；
- Manifest 严格校验；
- Registry、Gate 和 Host approvals 同步；
- executable、argv、cwd、作用域、超时和环境精确匹配；
- Gateway 重启后验证；
- 更新时清理旧 approval；
- 未登记入口恢复为 `CONFIG_ERROR`。

无外部副作用的烟测 Skill 已完成：

```text
inspect
→ register dry-run
→ register apply
→ 重复注册无写入
→ verify
→ remove
→ 最终未注册
```

现有固定业务 Skill 已完成 Registry、Gate、Host approvals 和作用域核验。公开仓库不包含这些私有 Skill 的源码、生产 Manifest、实际 executable、真实 argv 或身份范围。

### REM

真实 REM 扫描已完成两类验证：

```text
完整读取验证：15 个文件成功，缺失 topics/ 按 SKIPPED 处理
事务注册后 Gateway E2E：仅一次 exec，发现 7 个文件
```

固定 `find` 不再出现 allowlist miss，单个文件或目录缺失不会导致整个扫描中止。验证过程未执行写入或外部业务动作。

### 福利任务编排

福利任务编排能力已完成 Registry、Gate、Host approvals 和作用域核验。

未执行：

- Grant 新建、扩容或重置；
- 已停用 Cron 恢复；
- 下单或支付；
- 超出合法周期和额度的外部业务动作。

### 本地恢复 CLI

已实现并自检以下能力：

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

恢复 CLI 的设计边界：

- 仅服务器本地受信任用户可用；
- 不监听网络；
- 默认 dry-run；
- 每次变更自动备份、审计并支持撤销；
- 拒绝通配符、Shell 控制符和宽泛解释器入口；
- 不提供支付、下单、危险删除或秘密导出能力。

### 测试和版本管理

```text
Execution Gate 测试：102 passed, 0 failed
Gateway 重启后：active
本地 Git：main 分支，工作区 clean
事务注册本地提交：922465f
公开远端：仅发布脱敏通用模板和说明
```

## 有意保留的安全边界

以下行为仍不允许直接执行：

- 任意未知 Shell；
- 任意解释器或脚本；
- 未登记 executable；
- 支付、下单、转账；
- Token、Cookie、密码或密钥导出；
- 批量破坏性删除；
- 开放公网和扩大身份白名单；
- 绕过 Grant 额度、周期和作用域。

这些限制不是功能缺陷。

## 尚待实例所有者验证

- 在合法 Grant 周期和额度内运行的外部福利任务；
- 不包含生产数据的完整恢复演练。

不得为了完成验收而重置 Grant、扩大授权、触发下单或支付。

<!-- 用途：记录脱敏后的真实验证范围和未完成边界。 -->
