# MCP 管理模块

公开模板提供 `mcp-schema.js`、`mcp-management.js`、`mcp-cli-adapter.js` 和受限 wrapper，用于构建结构化 MCP 管理流程。

核心快捷安装只启用透明 Execution Gate，不默认暴露一个可修改配置的 `mcp_manage` Agent 工具。部署者需要在自己的 OpenClaw 适配层中显式注册该工具，并让修改操作复用 frozen operation、一次性消费和固定 wrapper。

普通已安装 MCP 工具仍由 Execution Gate 按其结构化调用和实际副作用判断，不依赖 `mcp_manage` 才能被保护。

## 建议风险分级

```text
list / status / show / doctor / probe
→ 已证明只读时直接读取

add / update / login / logout / remove / enable / disable
→ WAIT_CONFIRM
```

确认操作应保存规范化请求和参数哈希。批准后从 operation store 读取冻结请求，通过固定 wrapper 执行，并保持一次性消费。

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

示例：

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
