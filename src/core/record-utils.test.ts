import { describe, expect, it } from "vitest";
import { filterRecordBySymbols, limitTimestampedRecord } from "./record-utils";

describe("record utils", () => {
  it("limits timestamped records by most recent entries", () => {
    expect(
      limitTimestampedRecord(
        {
          old: { timestamp: 10, value: "old" },
          missing: { value: "missing" },
          latest: { timestamp: 30, value: "latest" },
          middle: { timestamp: 20, value: "middle" },
        },
        2
      )
    ).toEqual({
      latest: { timestamp: 30, value: "latest" },
      middle: { timestamp: 20, value: "middle" },
    });
  });

  it("filters records to a symbol set", () => {
    expect(
      filterRecordBySymbols(
        {
          AAPL: { value: 1 },
          MSFT: { value: 2 },
          TSLA: { value: 3 },
        },
        new Set(["AAPL", "TSLA"])
      )
    ).toEqual({
      AAPL: { value: 1 },
      TSLA: { value: 3 },
    });
  });
});
