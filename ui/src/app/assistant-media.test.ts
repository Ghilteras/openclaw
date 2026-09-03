import { describe, expect, it, vi } from "vitest";
import { resolveAssistantMedia } from "./assistant-media.ts";

describe("resolveAssistantMedia", () => {
  it("mints an exact-source capability over the authenticated Gateway client", async () => {
    const result = {
      available: true as const,
      mediaTicket: "ticket-local-media",
      mediaTicketExpiresAt: "2026-09-03T12:00:00.000Z",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const request = vi.fn().mockResolvedValue(result);

    await expect(
      resolveAssistantMedia({ request } as never, "/tmp/browser-shot.png"),
    ).resolves.toEqual(result);
    expect(request).toHaveBeenCalledWith(
      "assistant.media.get",
      { source: "/tmp/browser-shot.png" },
      { timeoutMs: 30_000 },
    );
  });
});
