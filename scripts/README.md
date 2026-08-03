# scripts 目录

本目录保存测试、安装器自测、OpenClaw 审批界面适配、公开导出和脱敏验证脚本。

主要入口：

- `run-tests.sh`：在隔离的虚构 OpenClaw 环境运行当前回归测试；
- `test-installer.sh`：使用模拟 OpenClaw 与 systemd 验证 `install.sh --apply`；
- `patch-openclaw-approval-ui.mjs`：为已识别的 OpenClaw 运行包应用中文文案补丁；
- `verify-public-template.sh`：检查当前发布树中的秘密和私有文件；
- `verify-private-data.sh`：检查账号、地址、金额和个人业务数据；
- `export-public-template.sh`：导出不含 `.git` 和私有覆盖层的公开副本。
