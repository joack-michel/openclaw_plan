# Skill 一键注册与白名单同步

本模板提供事务式 Skill 注册机制，用于解决执行型 Skill 需要同时修改 Execution Gate、Host approvals、Agent 作用域和运行约束的问题。

## 新的注册流程

```text
execution-manifest.json
→ 事务注册器
→ Skill Registry
→ Execution Gate
→ Host approvals
→ Gateway 验证
```

每个执行型 Skill 使用一份：

```text
execution-manifest.json
```

Manifest 只描述权限边界，不得包含 Token、Cookie、密码、密钥、真实身份、认证材料或私有业务参数。

## 标准流程

以下命令以仓库根目录为当前目录。

### 1. 检查 Skill

```bash
node bin/skill-registry-cli.mjs skill inspect \
  examples/skills/example-skill
```

`inspect` 是只读检查，不修改 Registry、Gate 或 approvals。

它会检查：

- Manifest schema；
- Skill ID 和 capability 冲突；
- executable、argv 和 cwd；
- 相对路径、符号链接和路径逃逸；
- 通配符、Shell 控制符和内联执行；
- Agent、channel 和 actor scope；
- timeout、环境、去重与重试边界；
- 当前 Registry 是否漂移。

### 2. 预览注册

```bash
node bin/skill-registry-cli.mjs skill register \
  examples/skills/example-skill
```

注册器默认 dry-run，只显示将要修改的内容：

```text
Skill ID
Manifest hash
Capability
Risk level
Executable
脱敏 argv
cwd
Agent / channel scope
将新增或替换的 approval
是否需要重启 Gateway
```

### 3. 正式注册

```bash
node bin/skill-registry-cli.mjs skill register \
  examples/skills/example-skill \
  --apply
```

正式注册使用原子事务：

```text
获取互斥锁
→ 自动备份
→ 校验 Manifest
→ 更新临时 Registry
→ 同步 Gate
→ 同步 Host approvals
→ 运行检查与测试
→ 原子替换正式文件
→ 必要时重启 Gateway
→ 读取有效策略验证
```

任何阶段失败都会回滚，不应留下半注册状态。

### 4. 验证注册结果

```bash
node bin/skill-registry-cli.mjs skill verify \
  examples/skills/example-skill
```

验证内容包括：

- Manifest hash 一致；
- Registry 已登记；
- Gate capability 已加载；
- executable 与 argv 精确匹配；
- cwd、超时和环境约束一致；
- Host approval 存在且无旧规则残留；
- Gateway 已加载最新 Registry。

`verify` 不会执行真实业务动作。

## 更新 Skill

先预览：

```bash
node bin/skill-registry-cli.mjs skill update \
  examples/skills/example-skill
```

正式应用：

```bash
node bin/skill-registry-cli.mjs skill update \
  examples/skills/example-skill \
  --apply
```

更新会替换旧 approval，不能同时残留新旧入口。权限扩大应明确标记：

```text
SECURITY_SCOPE_EXPANSION
```

## 查看全部 Skill

```bash
node bin/skill-registry-cli.mjs skill list
node bin/skill-registry-cli.mjs skill verify --all
```

## 注销 Skill

先预览：

```bash
node bin/skill-registry-cli.mjs skill remove example-skill
```

正式注销：

```bash
node bin/skill-registry-cli.mjs skill remove example-skill --apply
```

注销只移除 Registry 记录、Gate 注册、Host approval 和对应派生缓存，不应自动删除 Skill 文件、Cron、Grant 或业务数据。

## Manifest 示例

```json
{
  "schemaVersion": 1,
  "skillId": "example-skill",
  "description": "无外部副作用的示例能力",
  "enabled": true,
  "agents": ["main"],
  "capability": {
    "name": "EXAMPLE_ACTION",
    "riskLevel": "L1"
  },
  "entry": {
    "executable": "/absolute/path/to/executable",
    "argv": ["/absolute/path/to/fixed-script"],
    "cwd": "/absolute/path/to/skill"
  },
  "constraints": {
    "allowExtraArgs": false,
    "allowInlineEval": false,
    "allowShellOperators": false,
    "allowEnvironmentOverride": false,
    "timeoutSeconds": 15
  },
  "execution": {
    "dedupeKey": "example-skill:action",
    "dedupeSeconds": 10,
    "maxAttempts": 1,
    "retryOnUnknown": false
  }
}
```

具体字段以仓库中的 JSON Schema 和 CLI 帮助输出为准。

## 安全边界

- 只能由服务器本地受信任用户调用；
- Telegram 和普通 Agent 不能注册或扩大权限；
- 默认 dry-run；
- 修改前自动备份；
- 失败自动回滚；
- 禁止宽泛放行 Bash、Node、Python 或任意脚本；
- 使用解释器时必须锁定唯一脚本与精确 argv；
- 未登记 executable 继续返回 `CONFIG_ERROR`；
- `CONFIG_ERROR` 不创建 `WAIT_CONFIRM`；
- 注册、更新和验证不得触发外部领取、下单、支付或其他真实业务动作；
- 私有业务 Skill、生产 Manifest 和真实 approvals 不应上传公开仓库。

## 常见错误

### `CONFIG_ERROR`

表示 executable、argv、cwd、作用域或 Host approval 未命中。它属于配置错误，反复回复“确认”不能修复。

### Manifest 校验失败

检查 schemaVersion、必填字段、绝对路径、通配符、Shell 控制符和秘密字段。

### Registry 漂移

Manifest、Registry、Gate 或 Host approvals 不一致时，先运行 `skill verify`，再通过 `skill update` 的 dry-run 查看差异。

### Gateway 未加载

注册文件正确但运行时仍使用旧版本时，通过本地恢复 CLI 校验配置并重启 Gateway，不要扩大白名单绕过问题。

<!-- 用途：说明事务式 Skill 注册、更新、验证与注销流程。 -->
