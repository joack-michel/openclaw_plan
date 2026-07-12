# Architecture

```text
tool call -> effect resolver -> capability resolver -> risk resolver
          -> ALLOW | CONFIRM(operation) | DENY
```

Confirmation state is persisted in a new local SQLite database created at deployment time. Automation Grants are generated from example or private automation definitions and are evaluated on every tool call. Grant scope does not replace tool/parameter binding for confirmed operations.

Platform adapters expose query, claim, order, and payment effects. This repository ships mock/example provider descriptions only. Access control is a generic disabled adapter configured through the private overlay.
