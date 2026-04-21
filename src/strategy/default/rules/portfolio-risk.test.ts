import { describe, expect, it } from "vitest";
import { checkPortfolioRisk } from "./portfolio-risk";

describe("portfolio risk", () => {
  it("does not block entries when sector data is unknown", () => {
    const result = checkPortfolioRisk(
      "NVDA",
      {},
      [
        { symbol: "AAPL" },
        { symbol: "MSFT" },
        { symbol: "AMD" },
      ] as never,
      {
        portfolio_risk_enabled: true,
        max_positions_per_sector: 2,
      }
    );

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("Sector unknown");
  });

  it("still blocks known sector over-concentration", () => {
    const result = checkPortfolioRisk(
      "MSFT",
      {
        AAPL: "technology",
        NVDA: "technology",
        MSFT: "technology",
      },
      [
        { symbol: "AAPL" },
        { symbol: "NVDA" },
      ] as never,
      {
        portfolio_risk_enabled: true,
        max_positions_per_sector: 2,
      }
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("technology");
  });
});
