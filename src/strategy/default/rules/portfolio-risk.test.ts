import { describe, expect, it } from "vitest";
import { checkPortfolioRisk } from "./portfolio-risk";

describe("portfolio risk", () => {
  it("allows unknown sector entries up to their own cap", () => {
    const result = checkPortfolioRisk(
      "NVDA",
      {},
      [{ symbol: "AAPL" }, { symbol: "MSFT" }, { symbol: "AMD" }] as never,
      {
        portfolio_risk_enabled: true,
        max_positions_per_sector: 2,
        unknown_sector_max_positions: 4,
      }
    );

    expect(result.allowed).toBe(true);
    expect(result.reason).toContain("Sector unknown");
  });

  it("blocks unknown sector over-concentration", () => {
    const result = checkPortfolioRisk("NVDA", {}, [{ symbol: "AAPL" }, { symbol: "MSFT" }] as never, {
      portfolio_risk_enabled: true,
      max_positions_per_sector: 2,
      unknown_sector_max_positions: 2,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Unknown sector");
  });

  it("still blocks known sector over-concentration", () => {
    const result = checkPortfolioRisk(
      "MSFT",
      {
        AAPL: "technology",
        NVDA: "technology",
        MSFT: "technology",
      },
      [{ symbol: "AAPL" }, { symbol: "NVDA" }] as never,
      {
        portfolio_risk_enabled: true,
        max_positions_per_sector: 2,
        unknown_sector_max_positions: 2,
      }
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("technology");
  });
});
