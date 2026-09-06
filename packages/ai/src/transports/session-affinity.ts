import type { StreamOptions } from "../types.js";

function isOpencodeEndpoint(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname.replace(/\.$/, "") === "opencode.ai";
  } catch {
    return false;
  }
}

/** Required conversation identity is independent of optional prompt caching. */
export function resolveOpencodeSessionHeaders(
  baseUrl: string,
  options?: Pick<StreamOptions, "sessionId" | "headers">,
): Record<string, string> | undefined {
  if (!options?.sessionId || !isOpencodeEndpoint(baseUrl)) {
    return options?.headers;
  }
  if (
    Object.keys(options.headers ?? {}).some((name) => name.toLowerCase() === "x-opencode-session")
  ) {
    return options.headers;
  }
  return { ...options.headers, "x-opencode-session": options.sessionId };
}
