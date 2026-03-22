# Should I Be Trading?

A Bloomberg Terminal-style market dashboard for swing traders. It computes a **Market Quality Score**, an **Execution Window Score**, and a plain-English decision of **YES / CAUTION / NO** using live/latest Yahoo Finance market data and editable server-side scoring formulas.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Architecture

- **Backend:** `server.js` (Express API + 30-second cache + scoring engine).
- **Frontend:** `public/index.html`, `public/app.js`, `public/styles.css` (React UI loaded from CDN).
- **Data adapters:** Yahoo Finance chart endpoints for liquid market symbols. The code is organized so adapters can be swapped inside `fetchChart` / `fetchMany`.

## Scoring formulas

```text
Market Quality Score =
  Volatility * 0.25 +
  Momentum * 0.25 +
  Trend * 0.20 +
  Breadth * 0.20 +
  Macro * 0.10

Decision:
  80-100 = YES
  60-79  = CAUTION
  <60    = NO

Execution Window Score =
  average(
    breakoutsHolding,
    leadersHolding,
    pullbacksBought,
    followThrough
  )
```

## Example output snapshot

Latest local test snapshot captured on **March 22, 2026 (UTC)**:

```json
{
  "decision": "NO",
  "marketQualityScore": 23.3,
  "executionWindowScore": 56.3,
  "summary": "This is a defensive tape: chop conditions, breadth is thin, and volatility is elevated. Leadership is concentrated in XLE, XLF, XLK, while XLRE, XLB, XLU are lagging. Execution score is 56, so setups are mixed. macro pressure is hawkish."
}
```

## API recommendations

### Free / low-friction
- **Yahoo Finance chart endpoint**: broad symbol coverage, good for ETFs, indices, VIX proxies.
- **Stooq / Alpha Vantage**: useful fallback feeds for price history.
- **FRED**: strong option for Treasury yields and macro time series.
- **Financial Modeling Prep (free tier)**: sector performance and event calendar helpers.

### Paid / production-grade
- **Polygon.io**: equities, indices, breadth, aggregates, snapshot APIs.
- **Intrinio**: options, breadth, sector internals, fundamentals.
- **Barchart / Cboe DataShop**: derivatives sentiment, put/call, volatility surfaces.
- **Bloomberg / Refinitiv**: institutional-grade macro, breadth, calendar, and risk data.

## Notes

- Breadth and execution metrics use a liquid proxy basket when full exchange-level internals are unavailable from a free feed.
- Put/call is estimated from the volatility regime when a direct options-flow feed is unavailable.
- Switch between **Swing** and **Day** mode in the UI to apply tighter decision thresholds.
