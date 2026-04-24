# Strategy Architecture

This document describes the current strategy architecture after the harness/strategy decoupling work.

## Goals

The trading bot is split into three layers:

- `src/durable-objects/mahoraga-harness.ts`: Cloudflare Durable Object lifecycle, API routes, alarms, persistence, auth, and orchestration.
- `src/core/*`: reusable domain services and pure helpers shared by any strategy.
- `src/strategy/*`: pluggable trading logic, including data sources, prompts, candidate selection, and optional capabilities.

The harness should not import `src/strategy/default/*` directly. It talks only to `activeStrategy` from `src/strategy/index.ts` and to core services. This keeps custom strategies replaceable without editing Durable Object internals.

## Activation

The active strategy is selected in `src/strategy/index.ts`:

```ts
import { defaultStrategy } from "./default";
import type { Strategy } from "./types";

export const activeStrategy: Strategy = defaultStrategy;
```

To switch strategies, replace the import and export:

```ts
import { myStrategy } from "./my-strategy";
import type { Strategy } from "./types";

export const activeStrategy: Strategy = myStrategy;
```

## Strategy Contract

The main contract is `Strategy` in `src/strategy/types.ts`.

Required fields:

- `name`: stable strategy identifier used in logs and status payloads.
- `configSchema`: optional Zod schema that performs strategy-specific config validation after base config validation.
- `defaultConfig`: complete `AgentConfig` defaults for the strategy.
- `gatherers`: data sources that produce `Signal[]`.
- `prompts`: prompt builders for signal research, position research, analyst analysis, and premarket analysis.
- `selectEntries`: converts cached research into buy candidates.
- `selectExits`: converts open positions into sell candidates.

Optional fields:

- `capabilities`: strategy-specific side flows that are not universal, such as crypto trading, signal filtering, Twitter confirmation, options routing, and breaking news checks.
- `hooks`: lifecycle callbacks for initialization, alarm-cycle start/end, and successful buys/sells.

## Strategy Context

Every strategy function receives `StrategyContext`.

Important fields:

- `env`: Cloudflare environment bindings.
- `config`: validated current `AgentConfig`.
- `llm`: current LLM provider or `null`.
- `broker`: policy-protected broker adapter. Strategies should place trades through `ctx.broker.buy`, `ctx.broker.buyOption`, and `ctx.broker.sell`.
- `state`: persistent strategy/core state access.
- `signals`: current signal cache.
- `positionEntries`: tracked position entry metadata.
- `log`, `trackLLMCost`, `sleep`: shared utility functions.

State access:

```ts
ctx.state.set("myKey", value);
const value = ctx.state.get<MyValue>("myKey");
```

Namespaced state is available for new strategy-owned state:

```ts
const state = ctx.state.namespace?.("myStrategy");
state?.set("cache", cacheValue);
const cacheValue = state?.get<MyCache>("cache");
```

Prefer namespaced state for new custom strategy data. Existing default strategy state still uses some historical top-level keys for compatibility.

## Capabilities

Capabilities are optional so custom strategies are not forced to inherit default behavior.

Current capability hooks:

- `prepareDataGathering(ctx)`: run setup before gatherers, such as refreshing symbol metadata.
- `filterSignals(ctx, signals)`: normalize and validate gathered signals before caching.
- `runCryptoTrading(ctx, positions)`: run a 24/7 crypto-specific loop.
- `confirmEntry(ctx, candidate, signal, confidence)`: adjust entry confidence using a strategy-specific confirmation source.
- `findOptionsContract(ctx, symbol, direction, equity)`: route high-conviction entries through options.
- `checkBreakingNews(ctx, symbols)`: inspect held symbols for breaking-news risk.

The default strategy wires these in `src/strategy/default/index.ts`. For a custom strategy, omit capabilities you do not need.

## Core Services

Core services are strategy-independent and should be preferred over adding logic to the harness.

- `src/core/research-service.ts`: LLM prompt completion, model fallback, JSON parsing, and LLM cost tracking.
- `src/core/market-session.ts`: market-clock parsing, interval checks, premarket plan timing, and market-open execution-window decisions.
- `src/core/initial-state.ts`: creates an `AgentState` from the active strategy default config.
- `src/core/analyst-recommendations.ts`: shared LLM recommendation sizing and minimum-hold bypass guardrails.
- `src/core/status-payload.ts`: dashboard status payload shaping.
- `src/core/position-history.ts`: portfolio/position history request and point-shaping helpers.
- `src/core/record-utils.ts`: record limiting and symbol filtering helpers.
- `src/core/social-snapshot.ts`: social snapshot and history helpers.
- `src/core/asset-symbols.ts`: crypto symbol normalization and alias helpers.

If logic is reusable across strategies or is a pure domain rule, put it in `src/core`. If it is specific to a trading approach or data source, keep it under `src/strategy/<name>`.

## Alarm Flow

The Durable Object alarm remains the top-level scheduler:

1. Build a `StrategyContext`.
2. Fetch broker clock and build market session state via `core/market-session`.
3. Run data gathering when `data_poll_interval_ms` elapses.
4. Run signal research when `SIGNAL_RESEARCH_INTERVAL_MS` elapses.
5. Create or clear premarket plans based on market session state.
6. Sync tracked positions and broker-native protective stops.
7. Run optional strategy crypto trading.
8. Run position research when eligible.
9. During market hours, execute premarket plans and analyst cycles.
10. Run optional breaking-news checks.
11. Send daily Discord report if configured.
12. Persist state and schedule the next alarm.

The harness controls timing and persistence. The strategy controls candidate generation and optional strategy-specific behavior.

## Research Flow

Prompt builders live on the strategy:

- `researchSignal`
- `researchPosition`
- `analyzeSignals`
- `premarketAnalysis`

The harness asks the active strategy for prompts, then delegates completion to `ResearchService`. `ResearchService` handles:

- selected model and fallback model
- unknown-model fallback
- JSON parsing
- token/cost tracking

The harness remains responsible for storing results in `AgentState`.

## Default Strategy Layout

The built-in strategy is in `src/strategy/default`.

- `index.ts`: exports `defaultStrategy` and wires capabilities.
- `config.ts`: complete `DEFAULT_CONFIG` and compatibility `DEFAULT_STATE`.
- `gatherers/`: StockTwits, Reddit, SEC, crypto, Twitter helpers.
- `prompts/`: LLM prompt templates.
- `rules/`: entry, exit, crypto, options, scoring, regime, timing, portfolio-risk, and staleness rules.
- `helpers/`: default-only helpers such as ticker filtering and fallback research.

Default strategy internals can import default helpers. The harness should not.

## Adding A Custom Strategy

Minimum implementation:

```ts
import type { Strategy } from "../types";
import { DEFAULT_CONFIG } from "../default/config";

export const myStrategy: Strategy = {
  name: "my-strategy",
  configSchema: null,
  defaultConfig: {
    ...DEFAULT_CONFIG,
    max_positions: 3,
  },
  gatherers: [],
  prompts: {
    researchSignal: null,
    researchPosition: null,
    analyzeSignals: null,
    premarketAnalysis: null,
  },
  selectEntries: () => [],
  selectExits: () => [],
};
```

Then activate it in `src/strategy/index.ts`.

## Design Rules

- Do not import `src/strategy/default/*` from `src/durable-objects/mahoraga-harness.ts`.
- Put reusable pure logic in `src/core`.
- Put provider-specific API code in `src/providers`.
- Put trading behavior that varies by strategy in `src/strategy/<strategy-name>`.
- Add tests for every extracted pure helper or strategy rule.
- Prefer optional capabilities over adding hardcoded strategy branches to the harness.
- Prefer namespaced strategy state for new custom state keys.

## Verification

Run both checks after structural changes:

```bash
npm run typecheck
npm run test:run
```

At the time this document was added, the suite passed with `35` test files and `313` tests.
