# 剩余源码归档

本公开模板来自已经脱敏的第三版压缩包。为避免单次接口传输限制，部分较大的源码和测试文件保存在：

```text
archive/remaining-files.tgz.b64
```

该归档只包含已经脱敏的源码和测试，不包含生产凭据、数据库、日志或个人记忆。

在仓库根目录运行：

```bash
bash scripts/restore-remaining-files.sh
```

脚本会解码并还原以下文件到正常路径：

- `src/grant-store.js`
- `src/index.js`
- `src/operation-store.js`
- `test/exec-effect-resolver.test.js`
- `test/grant-store.test.js`
- `test/integrity-monitor.test.js`
- `test/mock-hook.test.js`
- `test/operation-store.test.js`
- `test/path-policy.test.js`
- `test/risk-resolver.test.js`
- `test/template-config.test.js`

还原后运行：

```bash
npm test
npm run build
```
