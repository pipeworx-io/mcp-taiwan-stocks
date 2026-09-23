# @pipeworx/taiwan-stocks

Taiwan equities MCP — prices, valuations, monthly sales, disclosures, margin balances and dividend dates for companies listed on the Taiwan Stock Exchange (TWSE, 上市) and the Taipei Exchange (TPEx, 上櫃). Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1669+ live data sources.

## Tools

- `taiwan_stock_quote(symbols)` — daily open/high/low/close, change, share volume and TWD turnover. Covers both boards.
- `taiwan_search_securities(query, market?, limit?)` — resolve a company name, English abbreviation or code to a listed security.
- `taiwan_company_profile(symbol)` — sector, chairman, president, incorporation and listing dates, paid-in capital, shares outstanding, auditor, website. TWSE main board.
- `taiwan_market_summary(days?)` — TAIEX and TPEx index levels with market-wide turnover, volume and transaction counts per session.
- `taiwan_stock_valuation(symbols)` — P/E, dividend yield and price-to-book as published daily by each exchange.
- `taiwan_monthly_revenue(symbol?, industry?, limit?)` — monthly sales (月營收) with MoM, YoY and year-to-date change; or a sector ranked by revenue growth.
- `taiwan_material_news(symbol?, query?, limit?)` — mandatory same-day disclosures (重大訊息): board resolutions, M&A, litigation, capital raises.
- `taiwan_top_traded(limit?)` — the twenty most heavily traded TWSE securities of the session.
- `taiwan_foreign_holdings(mode?, limit?)` — foreign and mainland-China ownership, by security or by sector, with headroom under the statutory ceiling.
- `taiwan_margin_balance(symbols)` — margin financing (融資) and short-sale (融券) balances with the day's activity and quotas.
- `taiwan_ex_dividend_calendar(symbol?, limit?)` — announced ex-dividend and ex-rights dates with cash and stock terms.

## Auth

None. Both exchanges publish these as open data with no key and no quota.

## Input conventions

Every tool that takes a symbol accepts three forms interchangeably:

| Form | Example |
|---|---|
| Numeric code | `2330`, `2330.TW`, `6488` |
| English abbreviation (the exchange's own) | `TSMC`, `HON HAI` |
| Chinese name | `台積電`, `鴻海` |

Codes are trusted without a company lookup, because ETFs and warrants trade on
TWSE without appearing in the company master.

## Gotchas

- **Two calendars in one API.** Most endpoints stamp the Republic-of-China year
  (`1150819` = 2026-08-19, `11507` = 2026-07); `MI_INDEX20` and the TPEx index
  history stamp plain Gregorian (`20260819`). The pack normalizes both to ISO.
- **Some JSON keys carry trailing spaces** — the disclosure feed's subject field
  is literally `"主旨 "`. Every key is trimmed on ingest.
- **These are whole-market files, not per-symbol endpoints.** There is no
  `/quote/2330`; the smallest unit is "everything that traded today" (318 KB on
  TWSE, ~4 MB on TPEx). The pack fetches the market file, caches it in-isolate
  for 5 minutes, and always tries the smaller TWSE file before falling through
  to TPEx.
- **TPEx refuses Cloudflare egress (open).** From the deployed gateway,
  `www.tpex.org.tw` answers HTTP 520 and then a redirect loop into `/errors`;
  the identical URL with the worker's exact User-Agent and Accept headers
  returns 200 from a laptop, so it is the egress IP, not the request. The pack
  routes TPEx through the egress relay when the gateway injects one and falls
  back to direct egress if the relay answers `host_not_allowed`, so the two can
  deploy in either order. **`www.tpex.org.tw` is in the relay's allow-list
  source but the edge function has not been redeployed yet** — until it is, TPEx
  calls fail and every tool degrades rather than throwing: TWSE results come
  back complete alongside `tpex_unavailable: true` and a reason, and an OTC
  symbol returns `reason: "tpex_unreachable"` instead of an empty result. An OTC
  security we could not reach and one that does not exist are different answers.
- **Coverage split.** Quotes, valuations and margin balances cover both boards.
  Company profiles, monthly revenue, disclosures, foreign holdings and the
  ex-dividend calendar are TWSE main-board files; a TPEx symbol comes back with
  `found: false` and a reason saying so rather than an empty result.
- **Publication timing.** Both exchanges publish after the 13:30 Taipei close,
  so before then the newest session shown is the previous trading day.
- Monthly revenue amounts are in **thousands of TWD**; margin balances are in
  **lots of 1,000 shares**.

## Data sources

- TWSE open data — `https://openapi.twse.com.tw/v1` ([spec](https://openapi.twse.com.tw/))
- TPEx open data — `https://www.tpex.org.tw/openapi/v1` ([spec](https://www.tpex.org.tw/openapi/))

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "taiwan-stocks": {
      "url": "https://gateway.pipeworx.io/taiwan-stocks/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/taiwan-stocks/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1669+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/taiwan_stock_quote \
  -H 'Content-Type: application/json' \
  -d '{"symbols":"TSMC,2317"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/taiwan_stock_quote`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "taiwan-stocks": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-taiwan-stocks"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-taiwan-stocks
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Taiwan Stocks data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
