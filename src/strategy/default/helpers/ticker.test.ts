import { describe, expect, it } from "vitest";
import { extractTickers } from "./ticker";

describe("ticker extraction helpers", () => {
  it("keeps explicit one-letter cashtags so valid tickers can be validated downstream", () => {
    expect(extractTickers("$F calls look strong, but F calls without the cashtag is ambiguous")).toContain("F");
  });

  it("does not extract one-letter context matches without an explicit cashtag", () => {
    expect(extractTickers("F calls look strong")).not.toContain("F");
  });

  it("still filters common blacklisted cashtags", () => {
    expect(extractTickers("$DD $YOLO $AAPL")).toEqual(["AAPL"]);
  });
});
