# Skill 一键注册与白名单同步

本模板提供事务式 Skill 注册机制，用于解决执行型 Skill 需要同时修改 Execution Gate、Host approvals、Agent 作用域和运行约束的问题。

## 设计目标

过去新增执行型 Skill 往往需要分别处理：

```text
SKILL.md
Execution Gate capability
风险等级
Host exec approvals
Agent / channel / actor scope
cwd、超时、环境、去重与重试
```

任意一层遗漏都会导致：

```text
CONFIG_ERROR
allowlist miss
Gate 已允许但主机拒绝
旧 approval 残留
```

新的注册流程改为：

```text
execution-manifest.json
→ 事务注册器
→ Skill Registry
→ Execution Gate
→ Host approvals
→ Gateway 验证
```

## 核心文件

公开模板中的注册器入口：

```text
bin/skill-registry-cli.mjs
```

每个执行型 Skill 使用一份：

```text
execution-manifest.json
```

Manifest 只描述权限边界，不得包含 Token、Cookie、密码、密钥、真实身份或认证材料。

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

注册器默认 dry-run。它只显示将要修改的内容，包括：

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

修改 Manifest、executable、argv、cwd 或风险范围后，先预览：

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

更新会替换旧 approval，不能同时残留新旧入口。

权限扩大应明确标记，例如：

```text
SECURITY_SCOPE_EXPANSION
```

## 查看全部 Skill

```bash
node bin/skill-registry-cli.mjs skill list
```

核验全部 Skill：

```bash
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

注销只移除：

- Registry 记录；
- Gate 注册；
- Host approval；
- 对应派生缓存。

它不应自动删除 Skill 文件、Cron、Grant 或业务数据。

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

注册器必须保持以下限制：

- 只能由服务器本地受信任用户调用；
- Telegram 和普通 Agent 不能注册或扩大权限；
- 默认 dry-run；
- 修改前自动备份；
- 失败自动回滚；
- 禁止宽泛放行 Bash、Node、Python 或任意脚本；
- 使用解释器时必须锁定唯一脚本与精确 argv；
- 未登记 executable 继续返回 `CONFIG_ERROR`；
- `CONFIG_ERROR` 不创建 `WAIT_CONFIRM`；
- 注册、更新和验证不得触发门禁、外部领取、下单或支付。

## 常见错误

### `CONFIG_ERROR`

表示 executable、argv、cwd、作用域或 Host approval 未命中。它属于配置错误，反复回复“确认”不能修复。

### Registry 漂移

Manifest 已修改，但 Registry 仍保存旧 hash。运行 `skill update`，不要直接手改 Registry。

### Host approval 缺失

Gate 已识别能力，但主机侧精确 approval 不存在。应通过注册器修复，不能全局放行解释器。

### Gateway 未加载新版本

Registry 和 approvals 已更新，但运行时仍使用旧快照。先运行 `skill verify`，再按恢复流程重启 Gateway。

<!-- 用途：说明事务式 Skill 注册、更新、验证和注销流程。 -->
