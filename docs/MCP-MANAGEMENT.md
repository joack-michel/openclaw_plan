# MCP 管理工具

公开模板提供结构化 `mcp_manage` 能力，用于管理普通 MCP Server。

## 风险分级

```text
list / status / show / doctor / probe
→ L0，直接读取

add / update / login / logout / remove / enable / disable
→ L2，进入 WAIT_CONFIRM
```

确认操作保存规范化请求和参数哈希。确认后从 operation store 读取冻结请求，通过固定 wrapper 执行，并保持一次性消费，不能用同一确认重复执行。

## 输入限制

允许：

```text
streamable-http
OAuth 元数据
仅引用环境变量名称的 bearer-env
固定 executable + 结构化 argv 的受限 stdio
```

拒绝：

```text
明文凭据
Authorization、Cookie 或敏感自定义 Header
带认证信息的 URL
任意 Shell、command、cwd 或 path
动态解释器参数
聊天中提交 OAuth 授权码
```

示例配置只使用占位符：

```json
{
  "action": "add",
  "name": "sample",
  "transport": "streamable-http",
  "url": "<MCP_URL>",
  "auth": {
    "type": "bearer-env",
    "env": "MCP_ACCESS_TOKEN"
  }
}
```

真实凭据必须保存在仓库外的受限环境文件或 Secret 存储中。
