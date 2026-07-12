# Remaining source archive

The public template was imported from the sanitized third package. A small set of larger source and test files is stored in `remaining-files.tgz.b64` to preserve the complete package without exposing runtime secrets.

From the repository root, run:

```bash
bash scripts/restore-remaining-files.sh
```

The script decodes and extracts the following sanitized files into their normal paths:

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

After extraction, run `npm test` and `npm run build`.
