# Execution policy example

| Effect | Decision |
|---|---|
| READ_OWN_WORKSPACE | ALLOW |
| WORKSPACE_FILE_MUTATION | ALLOW |
| CLAIM_COUPON | ALLOW within an active bounded grant |
| ORDER / PAYMENT | CONFIRM |
| SECURITY_POLICY_MUTATION | CONFIRM |
| Explicit disk destruction | DENY |
