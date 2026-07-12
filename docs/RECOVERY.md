# Recovery

1. Clone this public template.
2. Install dependencies.
3. Copy `.env.example` to `private-overlay/.env`.
4. Fill real values locally; do not commit the overlay.
5. Install the template into a deployment directory.
6. Apply the private overlay.
7. Initialize a new empty database from `sql/schema.sql`.
8. Import reviewed automation examples with new IDs.
9. Start OpenClaw Gateway.
10. Run tests, build, and manually validate high-risk confirmation behavior.

The public template cannot recover personal tokens, addresses, accounts, memories, or historical runtime state. Those must come from the owner's separately encrypted private backup.
