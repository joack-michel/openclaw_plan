# 脱敏记录

| 信息类别 | 公开模板中的表示方式 |
|---|---|
| 个人身份 | `<USER_NAME>`、`<USER_EMAIL>` |
| Telegram 身份 | `<TELEGRAM_USER_ID>`、`<TELEGRAM_CHAT_ID>`、`<BOT_USERNAME>` |
| 自动化运行状态 | `<JOB_ID>`、`<GRANT_ID>`、`<OPERATION_ID>`、`<RUN_ID>`、`<SESSION_ID>` |
| 地址与门禁 | `<COMMUNITY_NAME>`、`<BUILDING_ID>`、`<UNIT_ID>`、`<ACCESS_CONTROL_SCOPE>` |
| 服务器与网络 | `<SERVER_HOST>`、`<SERVER_IP>`、`<DOMAIN>`、`<WEBHOOK_URL>` |
| 凭据 | 仅保留环境变量名称和占位符 |

公开导出采用允许列表。数据库、日志、备份、会话、缓存、二进制文件和个人记忆默认不进入仓库。

普通开发验证期间，可以存在未被 Git 跟踪的本地 `private-overlay/`；发布验证会拒绝该目录。

在 Git 仓库中，`npm run verify` 会扫描：

```text
当前工作树
所有已跟踪路径（包括较早提交过的路径）
暂存内容
所有可恢复的 Git blob
```

`--release` 只用于不含 `.git` 的干净导出目录。

可以通过外部环境变量指定拒绝名单：

```text
SANITIZE_DENYLIST_FILE
```

拒绝名单文件必须位于仓库外部且不得被 Git 跟踪。扫描结果只输出文件路径、规则、行号和对象标识，不输出命中的真实值。
