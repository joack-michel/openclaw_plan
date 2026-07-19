# 脱敏记录

用途：说明公开仓库的脱敏范围、占位符规则和发布前检查方式。

| 信息类别 | 公开模板中的表示方式 |
|---|---|
| 个人身份 | `<USER_NAME>`、`<USER_EMAIL>` |
| Telegram 身份 | `<TELEGRAM_USER_ID>`、`<TELEGRAM_CHAT_ID>`、`<BOT_USERNAME>` |
| 自动化运行状态 | `<JOB_ID>`、`<GRANT_ID>`、`<OPERATION_ID>`、`<RUN_ID>`、`<SESSION_ID>` |
| 私有业务资源 | `<PRIVATE_RESOURCE_ID>`、`<PRIVATE_CAPABILITY_SCOPE>` |
| 服务器与网络 | `<SERVER_HOST>`、`<SERVER_IP>`、`<DOMAIN>`、`<WEBHOOK_URL>` |
| 物理位置和收货信息 | `<PRIVATE_LOCATION>`、`<POSTAL_ADDRESS>` |
| 金额、订单和账单数据 | `<REDACTED_AMOUNT>`、`<REDACTED_BILLING_DATA>` |
| 能源和公用事业数据 | `<REDACTED_UTILITY_DATA>` |
| 凭据 | 仅保留环境变量名称和占位符 |

公开导出采用允许列表。数据库、日志、备份、会话、缓存、二进制文件、个人记忆、真实地址、金额与账单明细默认不进入仓库。

普通开发验证期间，可以存在未被 Git 跟踪的本地 `private-overlay/`；发布验证会拒绝该目录。

在 Git 仓库中，`npm run verify` 会执行通用秘密扫描和私人数据扫描。检查范围包括当前工作树、已跟踪路径、可恢复 Git blob，以及恢复后的公开源码。

可以通过外部环境变量指定拒绝名单：

```text
SANITIZE_DENYLIST_FILE
```

拒绝名单文件必须位于仓库外部且不得被 Git 跟踪。扫描结果只输出文件路径、规则、行号和对象标识，不输出命中的真实值。
