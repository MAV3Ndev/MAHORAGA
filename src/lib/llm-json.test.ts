import { describe, expect, it } from "vitest";
import { parseLlmJsonObject } from "./llm-json";

describe("parseLlmJsonObject", () => {
  it("parses fenced JSON objects", () => {
    expect(parseLlmJsonObject<{ recommendation: string }>('```json\n{"recommendation":"HOLD"}\n```')).toEqual({
      recommendation: "HOLD",
    });
  });

  it("extracts JSON after reasoning text", () => {
    expect(
      parseLlmJsonObject<{ verdict: string }>(
        '<think>\nThe model reasons before answering.\n</think>\n{"verdict":"BUY"}'
      )
    ).toEqual({ verdict: "BUY" });
  });

  it("repairs raw newlines inside strings", () => {
    const parsed = parseLlmJsonObject<{ reasoning: string }>('{\n  "reasoning": "Line 1\nLine 2"\n}');
    expect(parsed.reasoning).toBe("Line 1\nLine 2");
  });

  it("repairs trailing commas", () => {
    const parsed = parseLlmJsonObject<{ key_factors: string[] }>('{ "key_factors": ["a", "b",], }');
    expect(parsed.key_factors).toEqual(["a", "b"]);
  });

  it("repairs unterminated string/object endings when recoverable", () => {
    const parsed = parseLlmJsonObject<{ reasoning: string; recommendation: string }>(
      '{ "recommendation": "SELL", "reasoning": "Momentum failed'
    );
    expect(parsed).toEqual({
      recommendation: "SELL",
      reasoning: "Momentum failed",
    });
  });
});
