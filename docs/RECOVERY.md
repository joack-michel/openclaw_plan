# 恢复流程

## 公开模板恢复

1. 克隆此公开模板；
2. 安装依赖；
3. 将 `.env.example` 复制为 `private-overlay/.env`；
4. 仅在本地填写真实值，不要提交私有覆盖层；
5. 把模板安装到独立运行目录；
6. 应用私有覆盖层；
7. 根据 `sql/schema.sql` 初始化新的空数据库；
8. 使用新的占位 ID 导入已经复核的自动化示例；
9. 启动 OpenClaw Gateway；
10. 运行测试、构建和脱敏检查；
11. 分别验证 L0、L1、L2、L3 行为；
12. 最后由实例所有者手动验证真实外部动作。

公开模板无法恢复以下个人数据：

```text
Token
Cookie
密码和密钥
地址和门禁信息
账号和个人记忆
生产 Cron、Grant、Operation ID
历史运行状态
数据库与日志
```

这些内容必须来自仓库所有者单独保存的加密私有备份。

## 本地恢复 CLI

推荐为生产实例提供仅限服务器本地受信任用户使用的恢复 CLI。

参考子命令：

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

恢复 CLI 应满足：

- 不监听网络；
- 不能由 Telegram 或远程消息触发；
- 默认使用 dry-run；
- 每次修改前自动备份；
- 所有操作写入审计日志；
- 支持撤销最近一次变更；
- 只允许绝对路径固定入口；
- 拒绝通配符、Shell 控制符和宽泛解释器入口；
- 解释器型入口必须同时锁定唯一脚本和参数；
- 不提供支付、下单、危险删除或秘密导出能力。

示例中的路径和命令必须使用占位符：

```text
<OPENCLAW_HOME>
<EXECUTION_GATE_HOME>
<FIXED_EXECUTABLE>
<FIXED_SCRIPT>
```

不得把生产服务器路径、真实账号、真实门禁脚本或生产 approvals 直接提交到公开仓库。

## 权限自锁恢复顺序

当 OpenClaw 无法读取配置、所有 exec 都出现 `allowlist miss` 或 Gate 进入错误的全局封锁时：

1. 从服务器本地终端进入恢复模式；
2. 查看有效配置、状态目录和主机 approvals；
3. 运行策略校验和脱敏诊断；
4. 仅修复固定入口或策略边界；
5. 重启 Gateway；
6. 先验证 L0 读取；
7. 再验证已登记 L1 能力；
8. 最后验证 L2/L3 仍受保护；
9. 确认无误后退出恢复模式。

不得通过全局 `security=full`、`ask=off`、任意 Shell 白名单或扩大 Grant 的方式解除自锁。

## 验收建议

恢复后至少验证：

```text
普通 Workspace 读取：直接执行
REM 扫描：缺失文件隔离，不因单个文件终止
固定业务入口：命中精确 approvals
allowlist miss：返回 CONFIG_ERROR，不进入确认循环
未知 Shell：不执行
权限扩大：确认一次
支付和破坏性操作：严格保护
Gateway 重启：规则持续生效
```

<!-- 用途：说明公开模板恢复、本地恢复 CLI 和权限自锁处理流程。 -->
