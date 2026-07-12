# Security model

This template prioritizes normal operation, prevention of model mistakes and duplicate effects, financial safety, recoverability, and auditability. Unknown high-impact behavior confirms rather than globally locking the system. Integrity mismatches are warning-only and auditable.

Credential-like paths and symlink escapes cannot inherit ordinary workspace permissions. Confirmation expires after fifteen minutes by default and is isolated by scope, operation, tool, and parameter hash. Access-control fast paths are disabled by default.
