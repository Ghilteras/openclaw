import { describe, expect, it, vi } from "vitest";
import { resolveAssistantMedia } from "./assistant-media.ts";

describe("resolveAssistantMedia", () => {
  it("mints an exact-source capability over the authenticated Gateway client", async () => {
    const request = vi.fn().mockResolvedValue({
      available: true,
      mediaTicket: "ticket-local-media",
      mediaTicketExpiresAt: "2026-09-02T20:00:00.000Z",
      mimeType: "image/png",
      sizeBytes: 42,
    });

    await expect(
      resolveAssistantMedia({ request } as never, "/tmp/browser-shot.png"),
    ).resolves.toEqual({
      available: true,
      mediaTicket: "ticket-local-media",
      mediaTicketExpiresAt: "2026-09-02T20:00:00.000Z",
      mimeType: "image/png",
      sizeBytes: 42,
    });
    expect(request).toHaveBeenCalledWith(
      "assistant.media.get",
      { source: "/tmp/browser-shot.png" },
      { timeoutMs: 30_000 },
    );
  });
});
