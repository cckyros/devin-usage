# Devin Usage

Subscription quota for **Devin Desktop** (Windsurf fork) — shown right in the status bar, like the official usage page but always visible.

![status bar](docs/statusbar.png)

## Features

- **Status bar**: `⚡ W 50% D 100%` — weekly & daily quota at a glance; turns amber ≤30%, red ≤10%
- **Dashboard** (click the status bar item):
  - Two rounded progress bars — daily quota + weekly quota, matching the official usage page
  - Overage charges due (purchase amount) and add-on credits
  - Reset countdowns with local reset time
- Auto-refresh every 5 min, manual refresh button, neutral unavailable state on failure
- Token stays in the IDE's secret storage; nothing leaves your machine except the single `GetUserStatus` call to `server.codeium.com`

## Install

```text
Extensions: Install from VSIX… → devin-usage-*.vsix
```

or drop the folder into `<user-data>/extensions/`.

## Sign in (one-time)

1. `Ctrl+Shift+P` → **Devin Usage: Sign In**
2. Browser opens `app.devin.ai/auth/windsurf/show-auth-code` (the official manual-auth page — same one Devin uses for SSH/remote setups)
3. Copy the auth code → paste into the input box
4. Done — the session token is exchanged and stored in secret storage

## Dev loop

```text
deploy.bat            # copies to %USERPROFILE%\.devin\extensions
Ctrl+Shift+P → Developer: Restart Extension Host
```

## How it works (notes for future me)

- Auth: browser `show-auth-code` → `ExchangeDevinCode` RPC (no auth header) → `sessionToken` (prefix `devi…`)
- Data: `POST https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus`, Connect-JSON, body `{metadata:{apiKey: token, ideName:"windsurf", …}}`
- `planStatus` fields used: `dailyQuotaRemainingPercent`, `weeklyQuotaRemainingPercent`, `overageBalanceMicros`, `daily/weeklyQuotaResetAtUnix`, `availableFlexCredits`, `planInfo.{planName,billingStrategy,hideDailyQuota,hideWeeklyQuota}`
- `windsurf_auth` provider sessions are whitelist-locked to `codeium.windsurf` in `product.json.trustedExtensionAuthAccess` — third-party `getSession` silently returns null, hence the manual-auth flow instead
- Private/undocumented RPC — expect breakage on Devin updates; `planStatus` field names follow protobuf JSON (lowerCamel)

## License

MIT
