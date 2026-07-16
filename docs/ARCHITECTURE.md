# 系统架构

```text
工具调用
  → Effect Resolver（效果解析器）
  → Capability Resolver（能力解析器）
  → Risk Resolver（风险解析器）
  → ALLOW | CONFIRM（创建待确认操作） | DENY
```

确认状态保存在部署时创建的本地 SQLite 数据库中。

Automation Grant 根据示例配置或私有自动化定义生成，并在每次工具调用时进行检查。Grant 的权限范围不能替代已确认操作对工具名称和参数哈希的绑定。

平台适配器按以下效果拆分：

```text
查询
领取
下单
支付
```

本仓库只提供 Mock 或示例 Provider，不包含真实账号和生产接口。
