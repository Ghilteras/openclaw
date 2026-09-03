import { classifyBoundedUnsignedDecimal } from "./arg-utils.runtime.mjs";

export * from "./arg-utils.runtime.mjs";

export function parseNonNegativeIntegerArg(raw: string | undefined, optionName: string): number {
  const result = classifyBoundedUnsignedDecimal(raw, 0, Number.MAX_SAFE_INTEGER);
  if (result.kind === "value") {
    return result.value;
  }
  throw new Error(`${optionName} expects a non-negative integer`);
}
