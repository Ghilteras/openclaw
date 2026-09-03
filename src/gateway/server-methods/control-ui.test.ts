import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import type { ControlUiGitHubPreview, ControlUiSessionPreview } from "../control-ui-contract.js";
import { createControlUiHandlers } from "./control-ui.js";
import type { RespondFn } from "./types.js";

function requestOptions(
  params: Record<string, unknown>,
  respond: RespondFn,
  overrides: { client?: { connId: string }; context?: unknown } = {},
) {
  return {
    client: (overrides.client ?? null) as never,
    context: (overrides.context ?? {}) as never,
    isWebchatConnect: () => false,
    params,
    req: { id: "1", method: "controlUi.githubPreview", params, type: "req" as const },
    respond,
  };
}

describe("controlUi.githubPreview", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    setActiveDegradedSecretOwners([]);
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    setActiveDegradedSecretOwners([]);
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(["anonymous", "authenticated"])(
    "returns public GitHub metadata when %s",
    async (mode) => {
      const preview: ControlUiGitHubPreview = {
        comments: 4,
        createdAt: "2026-07-05T08:00:00Z",
        kind: "issue",
        login: "octocat",
        number: 99815,
        owner: "openclaw",
        repo: "openclaw",
        state: "open",
        title: "Keep hover previews compact",
        updatedAt: "2026-07-05T09:55:00Z",
      };
      if (mode === "authenticated") {
        setRuntimeConfigSnapshot({
          gateway: { controlUi: { github: { token: "synthetic-preview-service-token" } } },
        });
      }
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        return Response.json(
          url.endsWith("/issues/99815")
            ? {
                comments: preview.comments,
                created_at: preview.createdAt,
                updated_at: preview.updatedAt,
                state: preview.state,
                title: preview.title,
                user: { login: preview.login },
                repository_url: "https://api.github.com/repos/openclaw/openclaw",
              }
            : { private: false },
        );
      });
      vi.stubGlobal("fetch", fetchMock);
      const handlers = createControlUiHandlers();
      const respond = vi.fn<RespondFn>();

      await expectDefined(
        handlers["controlUi.githubPreview"],
        'handlers["controlUi.githubPreview"] test invariant',
      )(
        requestOptions(
          { kind: "issue", number: 99815, owner: "openclaw", repo: "openclaw" },
          respond,
        ),
      );

      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(preview), undefined);
      expect(fetchMock).toHaveBeenCalledTimes(mode === "authenticated" ? 3 : 1);
    },
  );

  it("rejects malformed targets before loading GitHub", async () => {
    const loadPreview = vi.fn();
    const handlers = createControlUiHandlers(loadPreview);
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.githubPreview"],
      'handlers["controlUi.githubPreview"] test invariant',
    )(
      requestOptions(
        { kind: "issue", number: 1, owner: "openclaw/evil", repo: "openclaw" },
        respond,
      ),
    );

    expect(loadPreview).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid controlUi.githubPreview params",
    });
  });

  it.each([
    { name: "primary quota 403", status: 403, headers: { "x-ratelimit-remaining": "0" } },
    { name: "secondary quota 403", status: 403, headers: { "retry-after": "60" } },
    { name: "quota 429", status: 429, headers: {} },
  ])("preserves safe quota guidance through fetch for $name", async ({ name, status, headers }) => {
    const response = new Response("synthetic upstream body must stay private", {
      status,
    });
    for (const [key, value] of Object.entries(headers)) {
      response.headers.set(key, value);
    }
    response.headers.set("x-github-request-id", "synthetic-private-request-id");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    const handlers = createControlUiHandlers();
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.githubPreview"],
      'handlers["controlUi.githubPreview"] test invariant',
    )(
      requestOptions(
        { kind: "pull", number: 99816, owner: "openclaw", repo: name.replaceAll(" ", "-") },
        respond,
      ),
    );

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "GitHub preview unavailable",
      retryable: true,
      details: { code: "GITHUB_PREVIEW_UNAVAILABLE", reason: "rate_limited" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.bodyUsed).toBe(true);
  });

  it("preserves safe configured-unavailable guidance without fetching or borrowing ambient auth", async () => {
    setRuntimeConfigSnapshot({
      gateway: {
        controlUi: {
          github: { token: { source: "store", provider: "default", id: "SYNTHETIC_PREVIEW" } },
        },
      },
    });
    vi.stubEnv("GH_TOKEN", "synthetic-unrelated-ambient-token");
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const handlers = createControlUiHandlers();
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.githubPreview"],
      'handlers["controlUi.githubPreview"] test invariant',
    )(
      requestOptions({ kind: "pull", number: 99816, owner: "openclaw", repo: "openclaw" }, respond),
    );

    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message:
        "The configured Control UI GitHub credential is unavailable. Resolve gateway.controlUi.github.token and retry.",
      retryable: false,
      details: { code: "GITHUB_PREVIEW_UNAVAILABLE", reason: "credential_unavailable" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { name: "token-authorized private repository", status: 200, body: { private: true } },
    { name: "missing repository", status: 404, body: { message: "synthetic missing detail" } },
    { name: "denied repository", status: 403, body: { message: "synthetic permission detail" } },
    { name: "rejected credential", status: 401, body: { message: "synthetic credential detail" } },
  ])("keeps $name indistinguishable at the handler boundary", async ({ name, status, body }) => {
    setRuntimeConfigSnapshot({
      gateway: { controlUi: { github: { token: "synthetic-preview-service-token" } } },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json(body, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const handlers = createControlUiHandlers();
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.githubPreview"],
      "preview handler",
    )(
      requestOptions(
        { kind: "issue", number: 99816, owner: "openclaw", repo: name.replaceAll(" ", "-") },
        respond,
      ),
    );

    expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "GitHub preview unavailable",
      retryable: false,
      details: { code: "GITHUB_PREVIEW_UNAVAILABLE", reason: "unavailable" },
    });
    // Preserve the existing optional-auth behavior, including its anonymous retry.
    expect(fetchMock).toHaveBeenCalledTimes(status === 401 || status === 403 ? 2 : 1);
  });

  it("does not expose or trust details on an unknown fetch failure", async () => {
    const error = Object.assign(new Error("synthetic private network detail"), {
      statusCode: 429,
      details: { code: "GITHUB_PREVIEW_UNAVAILABLE", reason: "rate_limited" },
    });
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetchMock);
    const handlers = createControlUiHandlers();
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.githubPreview"],
      "preview handler",
    )(
      requestOptions(
        { kind: "issue", number: 99816, owner: "openclaw", repo: "unknown-fetch-error" },
        respond,
      ),
    );

    expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "GitHub preview unavailable",
      retryable: false,
      details: { code: "GITHUB_PREVIEW_UNAVAILABLE", reason: "unavailable" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("controlUi.sessionPreview", () => {
  it("returns bounded, redacted metadata for one session", async () => {
    const secret = "sk-test-session-preview-secret-1234567890";
    const loadSessionPreview = vi.fn().mockResolvedValue({
      sessionKey: "agent:main:research",
      title: `  ${"T".repeat(240)}  `,
      derivedTitle: "  Research notes  ",
      agentId: "main",
      kind: "direct",
      channel: "webchat",
      updatedAt: 1_786_000_000_000,
      lastMessagePreview: `  OPENAI_API_KEY=${secret} ${"x".repeat(240)}  `,
      archived: false,
    });
    const handlers = createControlUiHandlers(vi.fn(), loadSessionPreview);
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPreview"],
      'handlers["controlUi.sessionPreview"] test invariant',
    )(requestOptions({ sessionKey: " agent:main:research " }, respond));

    expect(loadSessionPreview).toHaveBeenCalledWith(
      "agent:main:research",
      expect.any(Object),
      null,
    );
    const payload = respond.mock.calls[0]?.[1] as ControlUiSessionPreview | undefined;
    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(payload).toMatchObject({
      status: "ok",
      sessionKey: "agent:main:research",
      derivedTitle: "Research notes",
      agentId: "main",
      kind: "direct",
      channel: "webchat",
      updatedAt: 1_786_000_000_000,
      archived: false,
    });
    if (payload?.status !== "ok") {
      throw new Error("expected an available session preview");
    }
    expect(payload.title).toHaveLength(200);
    expect(payload.lastMessagePreview?.length).toBeLessThanOrEqual(200);
    expect(payload.lastMessagePreview).not.toContain(secret);
  });

  it("returns unavailable for an unknown session", async () => {
    const handlers = createControlUiHandlers(vi.fn(), vi.fn().mockResolvedValue(null));
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPreview"],
      'handlers["controlUi.sessionPreview"] test invariant',
    )(requestOptions({ sessionKey: "agent:main:missing" }, respond));

    expect(respond).toHaveBeenCalledWith(true, { status: "unavailable" }, undefined);
  });

  it("rejects malformed preview params", async () => {
    const loadSessionPreview = vi.fn();
    const handlers = createControlUiHandlers(vi.fn(), loadSessionPreview);
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPreview"],
      'handlers["controlUi.sessionPreview"] test invariant',
    )(requestOptions({ sessionKey: "agent:main:research", extra: true }, respond));

    expect(loadSessionPreview).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid controlUi.sessionPreview params",
    });
  });
});

describe("controlUi.sessionPullRequests.subscribe", () => {
  it("replaces the connection watch set", async () => {
    const replace = vi.fn().mockResolvedValue(undefined);
    const handlers = createControlUiHandlers(vi.fn());
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions(
        { sessionKeys: [" agent:main:main ", "agent:main:main", "agent:work:main"] },
        respond,
        {
          client: { connId: "conn-control-ui" },
          context: { controlUiSessionPullRequests: { replace } },
        },
      ),
    );

    expect(replace).toHaveBeenCalledWith("conn-control-ui", ["agent:main:main", "agent:work:main"]);
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true }, undefined);
  });

  it("acknowledges a subscription before its cold snapshots finish loading", async () => {
    let finishHydration!: () => void;
    const hydration = new Promise<void>((resolve) => {
      finishHydration = resolve;
    });
    const replace = vi.fn(() => hydration);
    const handlers = createControlUiHandlers(vi.fn());
    const respond = vi.fn<RespondFn>();

    const request = expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions({ sessionKeys: ["agent:main:cold"] }, respond, {
        client: { connId: "conn-control-ui" },
        context: { controlUiSessionPullRequests: { replace } },
      }),
    );

    expect(replace).toHaveBeenCalledWith("conn-control-ui", ["agent:main:cold"]);
    expect(respond).toHaveBeenCalledWith(true, { subscribed: true }, undefined);
    finishHydration();
    await request;
  });

  it("accepts an empty replace-set as unsubscribe", async () => {
    const replace = vi.fn().mockResolvedValue(undefined);
    const handlers = createControlUiHandlers(vi.fn());
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions({ sessionKeys: [] }, respond, {
        client: { connId: "conn-control-ui" },
        context: { controlUiSessionPullRequests: { replace } },
      }),
    );

    expect(replace).toHaveBeenCalledWith("conn-control-ui", []);
    expect(respond).toHaveBeenCalledWith(true, { subscribed: false }, undefined);
  });

  it("rejects malformed replace-sets", async () => {
    const replace = vi.fn();
    const handlers = createControlUiHandlers(vi.fn());
    const respond = vi.fn<RespondFn>();

    await expectDefined(
      handlers["controlUi.sessionPullRequests.subscribe"],
      'handlers["controlUi.sessionPullRequests.subscribe"] test invariant',
    )(
      requestOptions({ sessionKeys: [" "] }, respond, {
        client: { connId: "conn-control-ui" },
        context: { controlUiSessionPullRequests: { replace } },
      }),
    );

    expect(replace).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "invalid controlUi.sessionPullRequests.subscribe params",
    });
  });
});
