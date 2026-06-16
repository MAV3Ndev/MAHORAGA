⚠️ **Warning:** This software is provided for educational and informational purposes only. Nothing in this repository constitutes financial, investment, legal, or tax advice.

# MAHORAGA

An autonomous, LLM-powered trading agent that runs 24/7 on Cloudflare Workers.

[![Discord](https://img.shields.io/discord/1467592472158015553?color=7289da&label=Discord&logo=discord&logoColor=white)](https://discord.gg/vMFnHe2YBh)
[![Sentinel](https://img.shields.io/badge/Sentinel-v1.0.0-00d4ff)](https://github.com/MAV3Ndev/MAHORAGA/releases/tag/sentinel-v1.0.0)

MAHORAGA monitors market/social signals from StockTwits, Reddit, Twitter/X confirmation, SEC filings, GDELT, Alpha Vantage, and crypto momentum, uses AI (OpenAI, Anthropic, Google, xAI, DeepSeek via AI SDK or Cloudflare AI Gateway) to analyze signals, and executes trades through Alpaca. It runs as a Cloudflare Durable Object with persistent state, automatic restarts, decision audit logs, and 24/7 crypto trading support.

The Windows and Android control app, **MAHORAGA SENTINEL**, is available from the [v1.0.0 release](https://github.com/MAV3Ndev/MAHORAGA/releases/tag/sentinel-v1.0.0). Sentinel can connect to a deployed Worker, edit runtime config, test social-source credentials, download trade-review logs, and check/install future Sentinel updates from GitHub Releases.

## Fork Notice

This repository is a public fork of the original [ygwyg/MAHORAGA](https://github.com/ygwyg/MAHORAGA). The original project established the Cloudflare Workers/Durable Object trading-agent foundation. This fork keeps that foundation and has diverged into an operational trading-agent distribution centered on MAHORAGA SENTINEL, a configurable strategy harness, stronger risk controls, and reviewable decision history.

The fork is maintained independently under `MAV3Ndev/MAHORAGA`. Upstream attribution is preserved, but issues, releases, configuration defaults, and Sentinel binaries in this repository should be treated as specific to this fork.

### Main changes from upstream

- **MAHORAGA SENTINEL v1.0.0** — Adds released Windows and Android app builds with authenticated remote connection setup, status monitoring, portfolio views, settings, notifications, trade-review export, and GitHub Release based update checks.
- **Release automation** — Adds GitHub Actions packaging for Sentinel, automatic changelog generation from `sentinel-v*` tags, Windows artifact publishing, and signed Android APK publishing when signing secrets are configured.
- **Desktop and mobile packaging** — Adds Electron support for Windows desktop builds and Capacitor/Android project files for mobile shells with native update handling.
- **Decision audit logs** — Adds D1-backed trade decision rows plus optional R2 snapshots, exposed through `/agent/trade-review` for reviewing why the agent bought, sold, skipped, or blocked a trade.
- **Expanded data sources** — Adds StockTwits, Reddit cookie access, Twitter/X cookie confirmation, SEC EDGAR, GDELT news, Alpha Vantage news sentiment, and crypto momentum gatherers.
- **Configurable source credentials** — Supports Twitter/X and Reddit cookie accounts with rotation and Dashboard connection tests, plus Dashboard/secret configuration for Alpha Vantage.
- **Risk and execution guardrails** — Adds stronger policy-broker routing, approval records, risk sizing, sell/exit safeguards, staleness handling, market-session planning, crypto sizing, and portfolio concentration checks.
- **Research pipeline refactor** — Extracts signal research, position research, social snapshots, status payloads, record shaping, ticker validation, source caching, and strategy hooks into smaller modules with focused tests.
- **LLM provider flexibility** — Supports direct OpenAI, Vercel AI SDK providers, and Cloudflare AI Gateway with configurable model names and base URLs.
- **Documentation refresh** — Adds strategy architecture docs and updates the generated documentation site for the pluggable strategy model.

<img width="1278" height="957" alt="dashboard" src="https://github.com/user-attachments/assets/56473ab6-e2c6-45fc-9e32-cf85e69f1a2d" />

## Features

- **24/7 Operation** — Runs on Cloudflare Workers, no local machine required
- **Multi-Source Signals** — StockTwits, Reddit, Twitter/X confirmation, SEC EDGAR, GDELT, Alpha Vantage, and crypto momentum
- **Multi-Provider LLM** — OpenAI, Anthropic, Google, xAI, DeepSeek via AI SDK or Cloudflare AI Gateway
- **Crypto Trading** — Trade BTC, ETH, SOL around the clock
- **Options Support** — High-conviction options plays
- **Staleness Detection** — Auto-exit positions that lose momentum
- **Pre-Market Analysis** — Prepare trading plans before market open
- **Discord Notifications** — Get alerts on BUY signals
- **Pluggable Strategy System** — Create custom strategies without touching core files
- **Trade Review Export** — Download indexed decision logs and R2 snapshots for post-trade analysis
- **Sentinel App** — Use the released Windows or Android app to monitor, configure, test credentials, export logs, and install app updates
- **Browser/Mobile Dashboard** — Run the dashboard in the browser, Electron, or Android shell

## Requirements

- Node.js 18+
- Cloudflare account (free tier works)
- Alpaca account (free, paper trading supported)
- LLM API key (OpenAI, Anthropic, Google, xAI, DeepSeek) or Cloudflare AI Gateway credentials
- Optional data-source credentials: Alpha Vantage API key, Reddit cookies, Twitter/X cookies, or Twitter bearer token

## Quick Start

### Option A. Use MAHORAGA SENTINEL

For normal operation, install Sentinel from the latest Sentinel release:

1. Download the Windows setup executable, or the Android APK if it is attached, from [GitHub Releases](https://github.com/MAV3Ndev/MAHORAGA/releases/tag/sentinel-v1.0.0).
2. Deploy the Worker using the steps below.
3. Open Sentinel and enter your Worker URL plus `MAHORAGA_API_TOKEN`.
4. Use **Settings** to edit runtime config, set Twitter/X or Reddit cookie accounts, set the Alpha Vantage key, and run credential connection tests.

Sentinel checks GitHub Releases for future `sentinel-v*` versions and can download/install updates from the app. Android updates require APKs signed with the same release key and the user's permission to install APKs from Sentinel.

### Option B. Run from source

#### 1. Clone and install

```bash
git clone https://github.com/MAV3Ndev/MAHORAGA.git
cd mahoraga
npm install
```

#### 2. Create Cloudflare resources

```bash
# Create D1 database
npx wrangler d1 create mahoraga-db
# Copy the database_id to wrangler.jsonc

# Create KV namespace
npx wrangler kv namespace create CACHE
# Copy the id to wrangler.jsonc

# Run migrations
npx wrangler d1 migrations apply mahoraga-db
```

#### 3. Set secrets

```bash
# Required
npx wrangler secret put ALPACA_API_KEY
npx wrangler secret put ALPACA_API_SECRET

# API Authentication - generate a secure random token (64+ chars recommended)
# Example: openssl rand -base64 48
npx wrangler secret put MAHORAGA_API_TOKEN

# LLM Provider (choose one mode)
npx wrangler secret put LLM_PROVIDER  # "openai-raw" (default), "ai-sdk", or "cloudflare-gateway"
npx wrangler secret put LLM_MODEL     # e.g. "gpt-4o-mini" or "anthropic/claude-sonnet-4"

# LLM API Keys (based on provider mode)
npx wrangler secret put OPENAI_API_KEY         # For openai-raw or ai-sdk with OpenAI
npx wrangler secret put OPENAI_BASE_URL        # Optional: override OpenAI base URL for openai-raw and ai-sdk (OpenAI models)
# npx wrangler secret put ANTHROPIC_API_KEY    # For ai-sdk with Anthropic
# npx wrangler secret put ANTHROPIC_AUTH_TOKEN # Optional alternative for Anthropic-compatible Bearer auth
# npx wrangler secret put ANTHROPIC_BASE_URL   # Optional: override Anthropic base URL for ai-sdk Anthropic models
# npx wrangler secret put GOOGLE_GENERATIVE_AI_API_KEY  # For ai-sdk with Google
# npx wrangler secret put XAI_API_KEY          # For ai-sdk with xAI/Grok
# npx wrangler secret put DEEPSEEK_API_KEY     # For ai-sdk with DeepSeek
# npx wrangler secret put CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID  # For cloudflare-gateway
# npx wrangler secret put CLOUDFLARE_AI_GATEWAY_ID          # For cloudflare-gateway
# npx wrangler secret put CLOUDFLARE_AI_GATEWAY_TOKEN       # For cloudflare-gateway

# Optional
npx wrangler secret put ALPACA_PAPER         # "true" for paper trading (recommended)
npx wrangler secret put ALPHA_VANTAGE_API_KEY
npx wrangler secret put REDDIT_COOKIES       # Optional fallback; Dashboard config supports multiple accounts
npx wrangler secret put REDDIT_USER_AGENT
npx wrangler secret put TWITTER_COOKIES      # Optional fallback; Dashboard config supports multiple accounts
npx wrangler secret put TWITTER_BEARER_TOKEN # Optional fallback if not using cookies
npx wrangler secret put DISCORD_WEBHOOK_URL
npx wrangler secret put KILL_SWITCH_SECRET   # Emergency kill switch (separate from API token)
```

Social-source cookies and Alpha Vantage can also be saved through Sentinel/Dashboard runtime config. Dashboard config is usually easier for rotating multiple Reddit or Twitter/X accounts and for running the built-in connection tests.

#### 4. Deploy

```bash
npx wrangler deploy
```

#### 5. Enable the agent

All API endpoints require authentication via Bearer token:

```bash
# Set your API token as an env var for convenience
export MAHORAGA_TOKEN="your-api-token"

# Enable the agent
curl -H "Authorization: Bearer $MAHORAGA_TOKEN" \
  https://mahoraga.your-subdomain.workers.dev/agent/enable
```

#### 6. Monitor

```bash
# Check status
curl -H "Authorization: Bearer $MAHORAGA_TOKEN" \
  https://mahoraga.your-subdomain.workers.dev/agent/status

# View recent runtime logs
curl -H "Authorization: Bearer $MAHORAGA_TOKEN" \
  https://mahoraga.your-subdomain.workers.dev/agent/logs

# Download trade-review logs with snapshots for analysis
curl -H "Authorization: Bearer $MAHORAGA_TOKEN" \
  "https://mahoraga.your-subdomain.workers.dev/agent/trade-review?days=90&limit=500&include_snapshots=true" \
  -o mahoraga-trade-review.json

# Emergency kill switch (uses separate KILL_SWITCH_SECRET)
curl -H "Authorization: Bearer $KILL_SWITCH_SECRET" \
  https://mahoraga.your-subdomain.workers.dev/agent/kill

# Run dashboard locally
cd dashboard && npm install && npm run dev
```

## Sentinel Release Process

Sentinel releases are driven by `sentinel-v*` tags. The release workflow builds the Windows app, verifies that `dashboard/package.json` matches the tag version, generates a changelog from commits since the previous Sentinel tag, and publishes GitHub Release artifacts.

```bash
cd dashboard
npm version 1.0.1 --no-git-tag-version
cd ..
git add dashboard/package.json dashboard/package-lock.json
git commit -m "Bump Sentinel to 1.0.1"
git tag sentinel-v1.0.1
git push origin main sentinel-v1.0.1
```

The published installer is the update target used by Sentinel's in-app updater. Keep version tags in the `sentinel-vX.Y.Z` format.

## Local Development

```bash
# Terminal 1 - Start wrangler
npx wrangler dev

# Terminal 2 - Start dashboard  
cd dashboard && npm run dev

# Terminal 3 - Enable the agent
curl -H "Authorization: Bearer $MAHORAGA_TOKEN" \
  http://localhost:8787/agent/enable
```

## Custom Strategies

Mahoraga uses a **pluggable strategy system**. The core harness is a thin orchestrator — all customizable logic lives in strategy modules. You never need to modify core files.

### How it works

1. Create `src/strategy/my-strategy/index.ts` implementing the `Strategy` interface
2. Change one import line in `src/strategy/index.ts`

```typescript
// src/strategy/index.ts
import { myStrategy } from "./my-strategy";
export const activeStrategy = myStrategy;
```

### What you can customize

| Component | File | What it does |
|-----------|------|--------------|
| **Gatherers** | `gatherers/*.ts` | Fetch signals from data sources (StockTwits, Reddit, etc.) |
| **Prompts** | `prompts/*.ts` | LLM prompt templates for research and analysis |
| **Entry rules** | `rules/entries.ts` | Decide which signals to buy |
| **Exit rules** | `rules/exits.ts` | Decide when to sell positions |
| **Config** | `config.ts` | Default parameters and source weights |

You can reuse default gatherers, mix in custom ones, override prompts, and define your own entry/exit rules — all without touching core files.

For the current responsibility boundaries, lifecycle hooks, optional capabilities, and extension rules, see `docs/strategy-architecture.md`.

### Adding a new data source

Create a gatherer that returns `Signal[]`:

```typescript
import type { Gatherer, StrategyContext } from "../../types";

const myGatherer: Gatherer = {
  name: "my-source",
  gather: async (ctx: StrategyContext) => {
    const res = await fetch("https://your-api.com/data");
    const data = await res.json();
    return data.items.map(item => ({
      symbol: item.ticker,
      source: "my_source",
      source_detail: "my_source_v1",
      sentiment: item.sentiment,
      raw_sentiment: item.sentiment,
      volume: 1,
      freshness: 1.0,
      source_weight: 0.9,
      reason: `MySource: ${item.summary}`,
      timestamp: Date.now(),
    }));
  },
};
```

Then include it in your strategy's `gatherers` array.

See `docs/harness.html` for the full customization guide.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `max_positions` | 5 | Maximum concurrent positions |
| `max_position_value` | 5000 | Maximum $ per position |
| `take_profit_pct` | 10 | Take profit percentage |
| `stop_loss_pct` | 5 | Stop loss percentage |
| `risk_per_trade_pct` | 0.75 | Max account risk per trade, used with stop distance / ATR sizing |
| `min_signal_quality_score` | 0.35 | Minimum signal quality before research and entry scoring |
| `min_sentiment_score` | 0.3 | Minimum sentiment to consider |
| `min_analyst_confidence` | 0.6 | Minimum LLM confidence to trade |
| `entry_require_technical_data` | false | Require RSI/SMA/BB data before allowing timed entries |
| `dynamic_tp_fallback_pct` | 12 | Dynamic take-profit target when ATR is unavailable |
| `unknown_sector_max_positions` | 2 | Separate concentration cap for positions with unknown sector |
| `options_enabled` | false | Enable options trading |
| `crypto_enabled` | false | Enable 24/7 crypto trading |
| `crypto_symbols` | BTC/ETH/SOL | Configured crypto symbols eligible for crypto trading |
| `crypto_max_position_value` | 1000 | Maximum $ per crypto position |
| `twitter_cookie_accounts` | [] | Multiple Twitter/X cookie accounts for rotated confirmation searches |
| `reddit_cookie_accounts` | [] | Multiple Reddit cookie accounts for rotated Reddit gatherer access |
| `alpha_vantage_api_key` | "" | Alpha Vantage news sentiment API key; can also be set as a Worker secret |
| `llm_model` | gpt-4o-mini | Research model (cheap, for bulk analysis) |
| `llm_analyst_model` | gpt-4o | Analyst model (smart, for trading decisions) |

### LLM Provider Configuration

MAHORAGA supports multiple LLM providers via three modes:

| Mode | Description | Required Env Vars |
|------|-------------|-------------------|
| `openai-raw` | Direct OpenAI API (default) | `OPENAI_API_KEY` |
| `ai-sdk` | Vercel AI SDK with 5 providers | One or more provider keys |
| `cloudflare-gateway` | Cloudflare AI Gateway (/compat) | `CLOUDFLARE_AI_GATEWAY_ACCOUNT_ID`, `CLOUDFLARE_AI_GATEWAY_ID`, `CLOUDFLARE_AI_GATEWAY_TOKEN` |

**Optional OpenAI Base URL Override:**

- `OPENAI_BASE_URL` — Override the base URL used for OpenAI requests. Applies to `LLM_PROVIDER=openai-raw` and OpenAI models in `LLM_PROVIDER=ai-sdk` (models starting with `openai/`). Default: `https://api.openai.com/v1`.

**Cloudflare AI Gateway Notes:**

- This integration calls Cloudflare's OpenAI-compatible `/compat/chat/completions` endpoint and always sends `cf-aig-authorization`.
- It is intended for BYOK/Unified Billing setups where upstream provider keys are configured in Cloudflare (so your worker does not send provider API keys).
- Models use the `{provider}/{model}` format (e.g. `openai/gpt-5-mini`, `google-ai-studio/gemini-2.5-flash`, `anthropic/claude-sonnet-4-5`).

**AI SDK Supported Providers:**

| Provider | Env Var | Example Models |
|----------|---------|----------------|
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-4o`, `openai/o1` |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4`, `anthropic/claude-opus-4` |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` | `google/gemini-2.5-pro`, `google/gemini-2.5-flash` |
| xAI (Grok) | `XAI_API_KEY` | `xai/grok-4`, `xai/grok-3` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek/deepseek-chat`, `deepseek/deepseek-reasoner` |

**Example: Using Claude with AI SDK:**

```bash
npx wrangler secret put LLM_PROVIDER      # Set to "ai-sdk"
npx wrangler secret put LLM_MODEL         # Set to "anthropic/claude-sonnet-4"
npx wrangler secret put ANTHROPIC_API_KEY # Your Anthropic API key
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `/agent/status` | Full status (account, positions, signals) |
| `/agent/enable` | Enable the agent |
| `/agent/disable` | Disable the agent |
| `/agent/config` | Get or update configuration |
| `/agent/logs` | Get recent logs |
| `/agent/trade-review` | Export indexed trade decisions, optionally with R2 snapshots |
| `/agent/trigger` | Manually trigger (for testing) |
| `/agent/kill` | Emergency kill switch (uses `KILL_SWITCH_SECRET`) |
| `/mcp` | MCP server for tool access |

## Security

### API Authentication (Required)

All `/agent/*` endpoints require Bearer token authentication using `MAHORAGA_API_TOKEN`:

```bash
curl -H "Authorization: Bearer $MAHORAGA_TOKEN" https://mahoraga.your-subdomain.workers.dev/agent/status
```

Generate a secure token: `openssl rand -base64 48`

### Emergency Kill Switch

The `/agent/kill` endpoint uses a separate `KILL_SWITCH_SECRET` for emergency shutdown:

```bash
curl -H "Authorization: Bearer $KILL_SWITCH_SECRET" https://mahoraga.your-subdomain.workers.dev/agent/kill
```

This immediately disables the agent, cancels all alarms, and clears the signal cache.

### Cloudflare Access (Recommended)

For additional security with SSO/email verification, set up Cloudflare Access:

```bash
# 1. Create a Cloudflare API token with Access:Edit permissions
#    https://dash.cloudflare.com/profile/api-tokens

# 2. Run the setup script
CLOUDFLARE_API_TOKEN=your-token \
CLOUDFLARE_ACCOUNT_ID=your-account-id \
MAHORAGA_WORKER_URL=https://mahoraga.your-subdomain.workers.dev \
MAHORAGA_ALLOWED_EMAILS=you@example.com \
npm run setup:access
```

This creates a Cloudflare Access Application with email verification or One-Time PIN.

## Project Structure

```
mahoraga/
├── wrangler.jsonc              # Cloudflare Workers config
├── src/
│   ├── index.ts                # Entry point & routing
│   ├── core/
│   │   ├── types.ts            # Shared types (Signal, AgentState, etc.)
│   │   └── policy-broker.ts    # PolicyEngine-wrapped trade execution
│   ├── durable-objects/
│   │   └── mahoraga-harness.ts # Core orchestrator (thin — delegates to strategy)
│   ├── strategy/
│   │   ├── types.ts            # Strategy interface contract
│   │   ├── index.ts            # Active strategy selector (change this one line)
│   │   └── default/            # Default "sentiment-momentum" strategy
│   │       ├── index.ts        # Strategy assembly
│   │       ├── config.ts       # Default config & source weights
│   │       ├── gatherers/      # StockTwits, Reddit, SEC, crypto, Twitter
│   │       ├── prompts/        # LLM prompt templates
│   │       ├── rules/          # Entry/exit/staleness/options/crypto rules
│   │       └── helpers/        # Ticker extraction, sentiment analysis
│   ├── mcp/                    # MCP server & tools
│   ├── policy/                 # Trade validation & risk engine
│   ├── providers/              # Alpaca, LLM providers
│   └── schemas/                # Config schemas (Zod)
├── dashboard/                  # React dashboard
├── docs/                       # Documentation
└── migrations/                 # D1 database migrations
```

## Safety Features

| Feature | Description |
|---------|-------------|
| Paper Trading | Start with `ALPACA_PAPER=true` |
| Kill Switch | Emergency halt via secret |
| Position Limits | Max positions and $ per position |
| Daily Loss Limit | Stops trading after 2% daily loss |
| Staleness Detection | Auto-exit stale positions |
| No Margin | Cash-only trading |
| No Shorting | Long positions only |

## Community

Join our Discord for help and discussion:

**[Discord Server](https://discord.gg/vMFnHe2YBh)**

## Disclaimer

**⚠️ IMPORTANT: READ BEFORE USING**

This software is provided for **educational and informational purposes only**. Nothing in this repository constitutes financial, investment, legal, or tax advice.

**By using this software, you acknowledge and agree that:**

- All trading and investment decisions are made **at your own risk**
- Markets are volatile and **you can lose some or all of your capital**
- No guarantees of performance, profits, or outcomes are made
- The authors and contributors are **not responsible** for any financial losses
- This software may contain bugs or behave unexpectedly
- Past performance does not guarantee future results

**Always start with paper trading and never risk money you cannot afford to lose.**

## License

MIT License - Free for personal and commercial use. See [LICENSE](LICENSE) for full terms.
