function stripJsonCodeFences(content: string): string {
  return content
    .replace(/```json\s*/gi, "")
    .replace(/```\s*$/gi, "")
    .replace(/```\s*/gi, "")
    .replace(/^[\n\r]+/, "")
    .trim();
}

function extractFirstJSONObject(content: string): string {
  const cleaned = stripJsonCodeFences(content);
  const startIndex = cleaned.indexOf("{");

  if (startIndex === -1) {
    return cleaned;
  }

  let depth = 0;
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex; index < cleaned.length; index++) {
    const char = cleaned[index];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === "\\" && inString) {
      isEscaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return cleaned.slice(startIndex, index + 1);
      }
    }
  }

  return cleaned.slice(startIndex);
}

function shouldDropTrailingComma(source: string, startIndex: number): boolean {
  for (let index = startIndex; index < source.length; index++) {
    const char = source[index];
    if (char === undefined) continue;
    if (/\s/.test(char)) continue;
    return char === "}" || char === "]";
  }
  return true;
}

function repairJsonLikeContent(content: string): string {
  const source = extractFirstJSONObject(content);
  let repaired = "";
  let inString = false;
  let isEscaped = false;
  const closingStack: string[] = [];

  for (let index = 0; index < source.length; index++) {
    const char = source[index];

    if (inString) {
      if (isEscaped) {
        repaired += char;
        isEscaped = false;
        continue;
      }

      if (char === "\\") {
        repaired += char;
        isEscaped = true;
        continue;
      }

      if (char === "\"") {
        repaired += char;
        inString = false;
        continue;
      }

      if (char === "\n") {
        repaired += "\\n";
        continue;
      }

      if (char === "\r") {
        repaired += "\\r";
        continue;
      }

      if (char === "\t") {
        repaired += "\\t";
        continue;
      }

      repaired += char;
      continue;
    }

    if (char === "\"") {
      repaired += char;
      inString = true;
      continue;
    }

    if (char === "{") {
      closingStack.push("}");
      repaired += char;
      continue;
    }

    if (char === "[") {
      closingStack.push("]");
      repaired += char;
      continue;
    }

    if (char === "}" || char === "]") {
      if (closingStack[closingStack.length - 1] === char) {
        closingStack.pop();
      }
      repaired += char;
      continue;
    }

    if (char === "," && shouldDropTrailingComma(source, index + 1)) {
      continue;
    }

    repaired += char;
  }

  if (inString) {
    repaired += "\"";
  }

  while (closingStack.length > 0) {
    repaired += closingStack.pop();
  }

  return repaired;
}

export function parseLlmJsonObject<T>(content: string): T {
  const cleaned = stripJsonCodeFences(content);
  const extracted = extractFirstJSONObject(content);
  const repairedCleaned = repairJsonLikeContent(cleaned);
  const repairedExtracted = extracted === cleaned ? repairedCleaned : repairJsonLikeContent(extracted);
  const candidates = [
    cleaned,
    extracted,
    repairedCleaned,
    repairedExtracted,
  ].filter((candidate, index, all) => candidate.length > 0 && all.indexOf(candidate) === index);

  let lastError: unknown = null;

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to parse LLM JSON object");
}
