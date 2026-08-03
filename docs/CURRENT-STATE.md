# OpenClaw Execution Gate 公开仓库状态

> 本文记录公开脱敏模板状态，不代表任何生产服务器的实时状态。

## 当前版本

```text
公开版本：0.3.0
适配基线：OpenClaw 2026.7.2-beta.4
Node.js：22 或更高
平台：Linux / systemd user service
```

## 已包含

- 透明工具调用风险判断；
- 冻结调用、上下文绑定和一次性消费；
- Task Grant 与五分钟范围授权；
- 精确 Cron 审批豁免与去重；
- 中文操作备注和审批状态文案；
- Skill 分析、Registry 和安装事务模块；
- MCP Schema、配置和 CLI adapter；
- SQLite Schema；
- 快捷安装器、失败配置恢复和隔离安装器自测；
- 当前公开回归测试与脱敏检查。

## 当前验证

```text
npm test：66/66
npm run build：通过
npm run verify：通过
git diff --check：通过后方可发布
```

测试数量以每次实际输出为准。

## 公开边界

本仓库不包含生产配置、真实审批数据库、个人身份、真实账号、个人记忆、生产 Cron、私有业务 Skill、Token、Cookie、密码或私钥。

默认验证检查当前发布树。`--history` 会进一步检查本地可恢复 Git 对象；旧历史清理属于单独的破坏性维护操作，不能由普通安装或发布脚本自动执行。
