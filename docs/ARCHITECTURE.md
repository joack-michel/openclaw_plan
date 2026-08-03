# 系统架构

```text
Agent 调用正常工具
  → Gateway 捕获结构化调用
  → Capability / Effect / Path Resolver
  → ALLOW | WAIT_CONFIRM | FINANCIAL_STEP_UP | DENY | ADMIN_PLANE_REQUIRED
```

普通安全只读调用直接执行。受保护调用写入本地 SQLite，保存工具名、调用 ID、规范化参数、actor、channel、session、runId、canonicalHash、结果路由、有效期和审批范围。

```text
WAIT_CONFIRM
  → 用户批准
  → 校验上下文和哈希
  → 原子一次性消费
  → 执行冻结的完全相同调用
  → 返回原会话
```

Task Grant 和五分钟范围授权只覆盖明确 scope。固定 Cron 可以使用绑定 Job、Agent、runId、工具和能力的窄范围授权。支付、最终下单、转账、凭据导出和安全核心修改不能被宽泛授权覆盖。

管理面、Integrity 和 Bootstrap 与普通业务面隔离。公开安装器只启用插件，不修改生产安全核心。
