# Changelog

## 0.1.0

- Status bar item: weekly + daily quota percent, color thresholds (≤30% warn, ≤10% crit)
- Dashboard webview: two rounded gradient progress bars (daily / weekly), overage charges, add-on credits, reset countdowns
- One-time browser sign-in via official show-auth-code flow (`ExchangeDevinCode` → session token in secret storage)
- Auto-refresh every 5 min + manual refresh; unavailable state on failure
