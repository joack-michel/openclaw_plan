# 自定义配置

实例相关的真实值应通过环境变量和 `private-overlay/` 提供。

部署新实例时：

1. 为 Automation 生成新的 ID；
2. 在激活前逐条检查 Grant；
3. 保持查询/领取权限与下单/支付权限分离；
4. 使用私有 Telegram ID 配置本人通知；
5. 不要把生产凭据写入公开仓库。

启用门禁 Provider 时，必须在私有配置中提供精确的 scope 和精确命令，并显式设置：

```dotenv
ACCESS_CONTROL_ENABLED=true
```

不要在本仓库中写入真实地址、设备信息或 Provider 凭据。
