# 台股強勢股偵測 (TW limit-up / swing detector)

A clone of the logic behind `ta-stock-swing-detector.vercel.app`: three tabs driven by free TWSE / TPEx public data.

| Tab | When | Rule |
|---|---|---|
| **今日開盤** | 09:15 | First 15-min bar: gain ≥ 7% and volume ≥ 7,000 lots (adjustable; presets 5/5,000 and 9/10,000). 🚀 gap = today's open > prev close × 1.05. Recorded floor is 3% / 1,000 lots, so "全部候選" shows everything recorded. If the scan runs late, the note says volume includes post-09:15 trading. |
| **明日觀察** | 15:10 | (Locked limit-up **and** turnover ≥ NT$3億 → badge 值) **or** (top-100 by volume **and** gain ≥ 9% → badge 量N). Both must close above the 60-day MA (季線). "明天第 N 根" = consecutive ≥ 9% days + 1. Turnover = close × volume. |
| **量增K** | 13:00, re-check 13:30 | Previous trading day gain ≥ 9% and today's volume already > yesterday's. |
| **熱門族群漲停** | 15:10 | Stocks up ≥ 9% with same-day news matching a hot theme (光通訊, 矽光子, 玻璃基板, 先進封裝 …). |

Data: TWSE MIS realtime (`getStockInfo.jsp`), TWSE `MI_INDEX` + TPEx `dailyQuotes` (history for the 60-day MA), TWSE/TPEx open-data 重大訊息 feeds, and the Google News RSS search feed (personal, non-commercial use only).

## How it runs

```
GitHub Actions (cron)  ──►  scripts/scan.mjs  ──►  commits public/data/*.json
                                                        │
Vercel (static site + /api/quotes live-price proxy) ◄───┘  redeploys on every push
```

## Setup (about 10 minutes, all free)

1. **Create a GitHub repo** (github.com → New repository, e.g. `tw-swing-detector`, public or private). Upload this folder's contents: either drag-and-drop in the web UI, or run:
   ```bash
   cd tw-swing-detector
   git remote add origin https://github.com/<you>/tw-swing-detector.git
   git push -u origin main
   ```
2. **Allow the workflow to push data:** repo → Settings → Actions → General → Workflow permissions → **Read and write permissions** → Save.
3. **Build the price history once:** repo → Actions → **scan** → Run workflow → mode `backfill`. It takes about 5–10 minutes and pulls around 100 days of daily quotes, which the 60-day MA needs.
4. **Deploy on Vercel:** vercel.com → Add New → Project → import the repo → Framework preset **Other** → Deploy. `vercel.json` already points it at `public/` and exposes `/api/quotes`.
5. That's it. Scans run automatically every trading day (Taiwan time):

| TW time | mode |
|---|---|
| 07:50 | premarket: sync history + announcements |
| 09:05 → waits to 09:15 | open (09:25 backup) |
| 13:00, 13:32 | volk |
| 15:10 | close: 明日觀察 + 熱門族群 |

Run any mode by hand from the Actions tab (use `force` to redo today's opening snapshot).

## Notes

- GitHub's scheduler can start jobs several minutes late. The site shows the scan time when that happens, just like the original does.
- GitHub pauses scheduled workflows in repos with no activity for 60 days. The bot's data commits normally keep the repo active.
- Thresholds live at the top of `scripts/scan.mjs` (`OPEN_FLOOR`, `GAP`, `WATCH`). The theme keyword list and ± headline scoring are in `scripts/lib.mjs`.
- Local run: `node scripts/scan.mjs backfill 100`, then `npx serve public` (live prices need `vercel dev`).
- This is technical detection only. It is not investment advice and never places orders.
