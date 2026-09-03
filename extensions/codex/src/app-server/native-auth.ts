import { spawnSync } from "node:child_process";
import { CODEX_APP_SERVER_AUTH_MARKER } from "openclaw/plugin-sdk/agent-runtime";

type CodexNativeAuthMode = "api-key" | "oauth" | "token";

const CODEX_NATIVE_AUTH_MODES: Readonly<Record<string, CodexNativeAuthMode>> = {
  "Logged in using ChatGPT": "oauth",
  "Logged in using access token": "token",
  "Logged in using personal access token": "token",
};

/** Ask Codex for login status without reading its credential storage. */
export function resolveCodexNativeAuth(
  params: {
    command?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const result = spawnSync(params.command ?? "codex", ["login", "status"], {
    encoding: "utf8",
    env: { ...process.env, ...params.env },
    maxBuffer: 16 * 1024,
    timeout: 3_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    return undefined;
  }
  const status = [result.stdout, result.stderr]
    .map((value) => value.trim())
    .filter(Boolean)
    .join("\n");
  const loggedInLine = status.split("\n").find((line) => line.startsWith("Logged in using "));
  // Codex also reports workload-identity and Amazon Bedrock logins; those never authorize the
  // OpenAI runtime, so only the OpenAI-backed modes become native auth.
  const mode = loggedInLine?.startsWith("Logged in using an API key")
    ? "api-key"
    : loggedInLine
      ? CODEX_NATIVE_AUTH_MODES[loggedInLine]
      : undefined;
  if (!mode) {
    return undefined;
  }
  return {
    apiKey: CODEX_APP_SERVER_AUTH_MARKER,
    source: "Codex CLI native auth",
    mode,
  };
}
