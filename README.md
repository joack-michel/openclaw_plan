# OpenClaw 执行门模板

这是一个经过脱敏处理的 OpenClaw 低摩擦执行门公开模板。仓库不包含生产数据库、真实凭据、个人记忆、地址、账号信息或运行状态。

## 风险模型

- **ALLOW（允许）**：普通工作区读写、状态查询，以及范围受限的自动化操作。
- **CONFIRM（确认）**：下单、支付、向第三方发送消息、修改凭据或安全策略，以及未知的高影响命令。
- **DENY（拒绝）**：明确的系统破坏操作和故意绕过安全限制的行为。

Telegram 确认流程会把待确认操作绑定到稳定的用户/频道范围、工具名称和参数哈希。模型仅在聊天中要求“确认”，不会自动创建真实待确认操作。

Automation Grant 会把已启用任务限制在指定的能力、工具、资源、命令、目标和运行上下文中。REM 扫描使用虚构记忆示例，并保证单个文件失败不会中断全部扫描。福利编排会把查询/领取能力与下单/支付能力分开。

门禁仅作为通用示例接口提供，默认关闭，不包含任何真实服务地址、物理位置或设备凭据。

> 说明：文档和用户可见说明使用中文；代码标识、环境变量、Capability 名称和命令仍保留英文，避免破坏兼容性。

## 安装

```bash
# 模板仓库：只包含可公开的代码。
git clone <REPOSITORY_URL> ~/openclaw-execution-gate-template
cd ~/openclaw-execution-gate-template
npm install

# 私有覆盖层：仅保留在本机，并被 Git 忽略。
mkdir -p private-overlay
cp .env.example private-overlay/.env
# 在本地编辑 private-overlay/.env。

# 运行目录：必须位于模板 Git 工作树之外。
bash scripts/install-template.sh ~/openclaw-execution-gate-runtime
bash scripts/apply-private-overlay.sh ~/openclaw-execution-gate-runtime
npm test
npm run build
```

请把以下目录分开：

```text
~/openclaw-execution-gate-template/                 公开 Git 模板
~/openclaw-execution-gate-template/private-overlay/ 本地私有配置（Git 忽略）
~/openclaw-execution-gate-runtime/                  实际运行目录
```

安装脚本和私有覆盖脚本会拒绝把运行目录放在模板 Git 工作树内部。不要直接把模板仓库本身当作生产部署目录。

更多说明：

- [系统架构](docs/ARCHITECTURE.md)
- [恢复流程](docs/RECOVERY.md)
- [自定义配置](docs/CUSTOMIZATION.md)
- [安全模型](docs/SECURITY-MODEL.md)
- [私有备份](docs/PRIVATE-BACKUP.md)

## 隐私与发布检查

不要提交以下内容：

```text
private-overlay/
数据库
日志
聊天记录
个人记忆
真实地址
Token、Cookie、密码和密钥
```

每次公开发布前运行：

```bash
npm run verify
```

在 Git 仓库中，`npm run verify` 会检查当前工作树、所有已跟踪路径、暂存内容和可恢复的 Git 历史。普通模式允许存在未被 Git 跟踪的本地 `private-overlay/`。

仅对不含 `.git` 的干净导出目录使用：

```bash
bash scripts/verify-public-template.sh --release
```

发布模式会拒绝 `private-overlay/`、数据库、日志和其他私有运行内容。

## 恢复压缩归档中的大文件

仓库中部分较大的源码和测试文件保存在：

```text
archive/remaining-files.tgz.b64
```

克隆后运行：

```bash
bash scripts/restore-remaining-files.sh
```

随后再执行：

```bash
npm test
npm run build
```
