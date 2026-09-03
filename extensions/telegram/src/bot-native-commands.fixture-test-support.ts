// Telegram plugin module implements bot native commands.fixture test support behavior.
import type {
  ModelsAuthLoginFlowOptions,
  ModelsAuthLoginFlowResult,
} from "openclaw/plugin-sdk/provider-auth-login-flow-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { vi } from "vitest";
import type { OpenClawConfig, TelegramAccountConfig } from "../runtime-api.js";
import type { TelegramNativeCommandDeps } from "./bot-native-command-deps.runtime.js";
import type { registerTelegramNativeCommands } from "./bot-native-commands.js";

type RegisterTelegramNativeCommandsParams = Parameters<typeof registerTelegramNativeCommands>[0];

export type NativeCommandTestParams = RegisterTelegramNativeCommandsParams & {
  allowFrom?: RegisterTelegramNativeCommandsParams["opts"]["allowFrom"];
  groupAllowFrom?: RegisterTelegramNativeCommandsParams["opts"]["groupAllowFrom"];
  replyToMode?: RegisterTelegramNativeCommandsParams["opts"]["replyToMode"];
};

export function createNativeCommandTestParams(
  params: Partial<NativeCommandTestParams> = {},
): RegisterTelegramNativeCommandsParams {
  const log = vi.fn();
  return {
    bot:
      params.bot ??
      ({
        api: {
          setMyCommands: vi.fn().mockResolvedValue(undefined),
          sendMessage: vi.fn().mockResolvedValue(undefined),
        },
        command: vi.fn(),
      } as unknown as NativeCommandTestParams["bot"]),
    cfg: params.cfg ?? ({} as OpenClawConfig),
    runtime:
      params.runtime ??
      ({
        log,
        error: vi.fn(),
        exit: vi.fn(),
      } as unknown as RuntimeEnv),
    accountId: params.accountId ?? "default",
    telegramCfg: params.telegramCfg ?? ({} as TelegramAccountConfig),
    nativeEnabled: params.nativeEnabled ?? true,
    nativeSkillsEnabled: params.nativeSkillsEnabled ?? false,
    resolveGroupPolicy:
      params.resolveGroupPolicy ??
      (() =>
        ({
          allowlistEnabled: false,
          allowed: true,
        }) as ReturnType<NativeCommandTestParams["resolveGroupPolicy"]>),
    resolveTelegramGroupConfig:
      params.resolveTelegramGroupConfig ??
      ((_chatId, _messageThreadId) => ({ groupConfig: undefined, topicConfig: undefined })),
    shouldSkipUpdate: params.shouldSkipUpdate ?? (() => false),
    telegramDeps: params.telegramDeps,
    opts: {
      ...(params.opts ?? { token: "token" }),
      allowFrom: params.allowFrom ?? params.opts?.allowFrom ?? [],
      groupAllowFrom: params.groupAllowFrom ?? params.opts?.groupAllowFrom ?? [],
      replyToMode: params.replyToMode ?? params.opts?.replyToMode ?? "off",
    },
  };
}

export function createTelegramPrivateCommandContext(params?: {
  match?: string;
  messageId?: number;
  date?: number;
  chatId?: number;
  userId?: number;
  username?: string;
  threadId?: number;
}) {
  return {
    match: params?.match ?? "",
    message: {
      message_id: params?.messageId ?? 1,
      date: params?.date ?? Math.floor(Date.now() / 1000),
      chat: { id: params?.chatId ?? 100, type: "private" as const },
      ...(params?.threadId != null ? { message_thread_id: params.threadId } : {}),
      from: { id: params?.userId ?? 200, username: params?.username ?? "bob" },
    },
  };
}

export function createTelegramGroupCommandContext(params?: {
  match?: string;
  messageId?: number;
  date?: number;
  chatId?: number;
  title?: string;
  userId?: number;
  username?: string;
}) {
  return {
    match: params?.match ?? "",
    message: {
      message_id: params?.messageId ?? 2,
      date: params?.date ?? Math.floor(Date.now() / 1000),
      chat: {
        id: params?.chatId ?? -1001234567890,
        type: "supergroup" as const,
        title: params?.title ?? "OpenClaw",
      },
      from: { id: params?.userId ?? 200, username: params?.username ?? "bob" },
    },
  };
}

export function createTelegramTopicCommandContext(params?: {
  match?: string;
  messageId?: number;
  date?: number;
  chatId?: number;
  title?: string;
  threadId?: number;
  userId?: number;
  username?: string;
}) {
  return {
    match: params?.match ?? "",
    message: {
      message_id: params?.messageId ?? 2,
      date: params?.date ?? Math.floor(Date.now() / 1000),
      chat: {
        id: params?.chatId ?? -1001234567890,
        type: "supergroup" as const,
        title: params?.title ?? "OpenClaw",
        is_forum: true,
      },
      message_thread_id: params?.threadId ?? 42,
      from: { id: params?.userId ?? 200, username: params?.username ?? "bob" },
    },
  };
}

/**
 * Stubs the SDK channel login flow with a core-flow stub. The prompter mirrors what the real
 * channel prompter delivers to Telegram: notes as messages, device codes through the sender.
 */
export function stubTelegramProviderLoginFlow(
  loginFlow: (
    options: ModelsAuthLoginFlowOptions,
  ) => Promise<
    Partial<ModelsAuthLoginFlowResult> &
      Pick<ModelsAuthLoginFlowResult, "providerId" | "methodId" | "profiles">
  >,
): TelegramNativeCommandDeps["runProviderChannelLoginFlow"] {
  return async (flow) => {
    const sendNote = async (message: string, title?: string) => {
      flow.signal?.throwIfAborted();
      const text = [title?.trim(), message.trim()].filter(Boolean).join("\n\n");
      if (text) {
        await flow.sendMessage(text);
      }
    };
    const result = await loginFlow({
      provider: flow.choice.providerId,
      method: flow.choice.methodId,
      ownerPluginId: flow.choice.pluginId,
      credentialOnly: true,
      agent: flow.agentId,
      ...(flow.profileId ? { profileId: flow.profileId } : {}),
      config: flow.config,
      runtime: flow.runtime,
      signal: flow.signal,
      isRemote: true,
      openUrl: async () => {},
      prompter: {
        note: sendNote,
        plain: sendNote,
        ...(flow.sendDeviceCode ? { deviceCode: flow.sendDeviceCode } : {}),
      } as never,
    });
    return { modelAccess: "already-visible", authRefresh: "refreshed", ...result };
  };
}
