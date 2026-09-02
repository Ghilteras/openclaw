/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  availableSidebarSlots,
  sidebarPanelActions,
  sidebarPanelDefinitions,
} from "./chat-pane-embedded-panels.ts";
import type { SessionDiscussionPanelConfig } from "./components/session-discussion-panel.ts";

type PanelTestOptions = {
  hasBoard?: boolean;
  canvasCommentAvailable?: boolean;
  canvasCommentMode?: boolean;
  onToggleCanvasComment?: () => void;
};

function panelDefinitions(discussionAvailable: boolean, options: PanelTestOptions = {}) {
  const discussion = {} as SessionDiscussionPanelConfig;
  return sidebarPanelDefinitions({
    discussion,
    discussionAvailable,
    ...options,
  } as Parameters<typeof sidebarPanelDefinitions>[0]);
}

function discussionSlots(discussionAvailable: boolean) {
  return availableSidebarSlots(panelDefinitions(discussionAvailable));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("chat pane embedded panels", () => {
  it("does not offer Discussion when no provider is available", () => {
    expect(discussionSlots(false)).not.toContain("discussion");
  });

  it("offers Discussion after the provider reports it available", () => {
    expect(discussionSlots(true)).toContain("discussion");
  });

  it("offers the Canvas commenter from the Board chat header", () => {
    const onToggleCanvasComment = vi.fn();
    const definitions = panelDefinitions(false, {
      hasBoard: true,
      canvasCommentAvailable: true,
      canvasCommentMode: true,
      onToggleCanvasComment,
    });
    const action = sidebarPanelActions(definitions).chat;
    const container = document.createElement("div");

    render(action, container);
    const button = container.querySelector<HTMLButtonElement>("button[data-canvas-comment-toggle]");

    expect(button?.getAttribute("aria-pressed")).toBe("true");
    button?.click();
    expect(onToggleCanvasComment).toHaveBeenCalledOnce();
  });

  it("enumerates a structural loading variant for every side-panel tab", async () => {
    const expected = {
      browser: "browser",
      chat: "chat",
      companion: "chat",
      desktop: "desktop",
      detail: "review",
      discussion: "discussion",
      tasks: "tasks",
      terminal: "terminal",
      workspace: "files",
    } as const;

    const definitions = sidebarPanelDefinitions();
    expect(definitions.map((definition) => definition.slot)).toEqual([
      "detail",
      "terminal",
      "browser",
      "workspace",
      "companion",
      "tasks",
      "desktop",
      "discussion",
      "chat",
    ]);
    for (const definition of definitions) {
      const mount = document.body.appendChild(document.createElement("div"));
      render(definition.loading, mount);
      const skeleton = mount.querySelector("openclaw-panel-loading-skeleton");
      await skeleton?.updateComplete;
      expect(skeleton?.getAttribute("data-panel-skeleton")).toBe(expected[definition.slot]);
    }
  });
});
