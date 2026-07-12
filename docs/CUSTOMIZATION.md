# Customization

Use environment variables and `private-overlay/` for instance-specific values. Generate new automation IDs and review every Grant before activation. Keep query/claim scopes separate from order/payment. Configure owner notification with a private Telegram ID.

To enable an access-control provider, supply an exact scope and exact command in private configuration and explicitly set `ACCESS_CONTROL_ENABLED=true`. Never put a real address or provider credential in this repository.
