# 执行策略示例

| Effect | 决策 |
|---|---|
| READ_OWN_WORKSPACE | ALLOW |
| WORKSPACE_FILE_MUTATION | ALLOW |
| CLAIM_COUPON | 在有效且范围受限的 Grant 内 ALLOW |
| ORDER / PAYMENT | CONFIRM |
| SECURITY_POLICY_MUTATION | CONFIRM |
| 明确的磁盘破坏操作 | DENY |

说明：Capability、Effect 和决策值保留英文，便于直接对应代码实现。

