# Leon's Ledger

A local Windows app for splitting every paycheck into buckets (spending, savings, debts, investments, anything else), tracking what's paid and what's left, with an AI advisor.

## Install
Run `Leons-Ledger-Setup-1.0.0.exe`. Windows SmartScreen may warn "Windows protected your PC" because the installer isn't code-signed. Click **More info → Run anyway**.

Your data is saved in `%APPDATA%\Leon's Ledger\ledger.json`. The app also keeps a daily backup in the `backups` folder (the last 30 days). Updating or reinstalling doesn't touch your data.

## Turn on the AI advisor
1. Create an API key at https://console.anthropic.com (API Keys). API use is paid per use, separately from a Claude subscription.
2. In the app, open **Settings**, paste the key and click **Save settings**.
3. When you log an income, the advisor comments on it automatically. You can also chat with it on the **AI advisor** page.

Without a key, the app gives offline rule-based tips instead.

## Features
- Income splitting into sections and categories, spend/pay with "paid / remaining" messages, moves between buckets
- **Wallets** (cash, cards, bank) with balances and wallet-to-wallet moves
- **USD or Lebanese lira** entry with your own exchange rate
- **Receipt scanning**: take a photo and the AI fills in the amount, date, shop and category
- **Recurring bills**: logged automatically, or as reminders with notifications
- **Goals & debts**: when each goal will be reached (with an "extra per month" slider), and a debt payoff planner (avalanche vs snowball)
- **Reports**: income vs money out, balance over time, top spending, by-type breakdown, monthly AI report
- **Export**: a designed PDF report, plus CSV that opens in Excel
- **Themes** (Black, Navy, Pink, Light), **PIN lock**, and a separate business budget

## How it works
- **Split plan**: each section gets a % of every income, and each category gets a % of its section. Both levels must add up to 100%. You can add, rename, recolor and delete sections and categories. Set a section's type to Spending, Savings, Debt, Investment or Other. For debts, enter the **total owed**. For savings, enter a **goal**.
- **Log income**: enter the amount and see the split preview. You can tick the box to use different percentages for this one payment only.
- **Spend / Pay**: pick the bucket and amount. The app then reports, for example, "$200 was paid for Car loan. $55 remaining in this budget. $800 still owed of $1,000." The **Move between buckets** tab moves money from one category to another.
- **History**: edit or delete any entry.
- Changing the plan only affects future incomes. Past incomes keep the split they were saved with.

## Updating the app (auto-update)
The installed app checks GitHub for a newer version every time it starts. When it finds one, it downloads it and shows **Restart & update**.

One-time setup:
1. Create a **public** GitHub repo named `leons-ledger` under `leonmarkarian`.
2. Push this folder to it.

To ship an update:
1. Change the code. (Or ask Claude to change it.)
2. Raise `"version"` in `package.json`, e.g. `1.0.0` → `1.0.1`.
3. Commit and push to `main`.
4. GitHub Actions notices the new version number, builds the installer and publishes the release. Installed copies pick it up on their next launch. Pushes that don't change the version don't create a release.

Without GitHub: build or receive a newer installer and run it over the current install. Your data stays.

## Phone version
The same app runs on phones at https://leonmarkarian.github.io/leons-ledger/.
- **Android (Chrome):** open the link, then choose ⋮ → **Add to Home screen** / **Install app**.
- **iPhone (Safari):** open the link, then choose Share → **Add to Home Screen**.

It updates itself every time you open it while you're online, and it works offline too. Data on the phone is separate from the PC. Use Settings → Export/Import backup to move data between them.

## Developing
```
npm install
npm start        # run the app
npm test         # logic tests
npm run dist     # build the installer (on Windows)
```
