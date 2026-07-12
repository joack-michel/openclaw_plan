# Security constitution example

- Ordinary workspace reads and writes are allowed.
- Orders, payments, third-party messages, security policy changes, and credential changes require confirmation.
- Explicit destructive system commands are denied.
- Integrity mismatch is warning-only and is audited.
- Access control fast paths are disabled until a private configuration explicitly enables one exact provider scope and command.
