import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { requestWidgetSnapshot } from "../../lib/board/widget-snapshot.ts";
import {
  buildBrowserAnnotationContent,
  composeAnnotatedImage,
  type AnnotationRegion,
  type BrowserAnnotationDraft,
} from "../browser/browser-annotation.ts";
import type { BrowserInspectedNode } from "../browser/browser-client.ts";

const INSPECT_REQUEST_TYPE = "openclaw:widget-inspect-request";
const INSPECT_RESULT_TYPE = "openclaw:widget-inspect-result";
const INSPECT_TIMEOUT_MS = 1_500;

type Rect = { x: number; y: number; width: number; height: number };

export type CanvasInspectedNode = BrowserInspectedNode & {
  viewportRect: Rect;
  documentSize: { width: number; height: number };
};

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rect(value: unknown): Rect | null {
  const record = asNullableRecord(value);
  if (!record) {
    return null;
  }
  const x = finite(record.x);
  const y = finite(record.y);
  const width = finite(record.width);
  const height = finite(record.height);
  return x === null || y === null || width === null || height === null || width < 0 || height < 0
    ? null
    : { x, y, width, height };
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function normalizeNode(value: unknown): CanvasInspectedNode | null {
  const record = asNullableRecord(value);
  if (!record) {
    return null;
  }
  const nodeRect = rect(record.rect);
  const viewportRect = rect(record.viewportRect);
  const documentSize = rect({
    x: 0,
    y: 0,
    ...asNullableRecord(record.documentSize),
  });
  if (
    !nodeRect ||
    !viewportRect ||
    !documentSize ||
    documentSize.width <= 0 ||
    documentSize.height <= 0 ||
    documentSize.width > 16_384 ||
    documentSize.height > 16_384
  ) {
    return null;
  }
  return {
    tag: boundedString(record.tag, 40),
    id: boundedString(record.id, 120),
    classes: Array.isArray(record.classes)
      ? record.classes
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 6)
          .map((entry) => entry.slice(0, 80))
      : [],
    selector: boundedString(record.selector, 500),
    role: boundedString(record.role, 80),
    name: boundedString(record.name, 120),
    rect: nodeRect,
    viewportRect,
    documentSize: { width: documentSize.width, height: documentSize.height },
    focusable: record.focusable === true,
  };
}

export function requestWidgetInspection(
  frame: HTMLIFrameElement,
  point: { x: number; y: number },
): Promise<CanvasInspectedNode | null> {
  const target = frame.contentWindow;
  if (!target) {
    return Promise.reject(new Error("widget frame is unavailable"));
  }
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener("message", handleMessage);
      globalThis.clearTimeout(timeout);
    };
    const handleMessage = (event: MessageEvent) => {
      if (
        event.source !== target ||
        event.data?.type !== INSPECT_RESULT_TYPE ||
        event.data.id !== id
      ) {
        return;
      }
      cleanup();
      resolve(normalizeNode(event.data.node));
    };
    window.addEventListener("message", handleMessage);
    const timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error("widget element inspection timed out"));
    }, INSPECT_TIMEOUT_MS);
    try {
      target.postMessage({ type: INSPECT_REQUEST_TYPE, id, x: point.x, y: point.y }, "*");
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error("widget snapshot failed to decode")), {
      once: true,
    });
    image.src = dataUrl;
  });
}

export async function buildCanvasElementAnnotation(params: {
  frame: HTMLIFrameElement;
  node: CanvasInspectedNode;
  title: string;
  widgetName: string;
}): Promise<BrowserAnnotationDraft> {
  const dataUrl = await requestWidgetSnapshot(params.frame);
  const image = await loadImage(dataUrl);
  const highlight: AnnotationRegion = {
    x: params.node.rect.x / params.node.documentSize.width,
    y: params.node.rect.y / params.node.documentSize.height,
    width: params.node.rect.width / params.node.documentSize.width,
    height: params.node.rect.height / params.node.documentSize.height,
  };
  const content = buildBrowserAnnotationContent({
    url: `canvas://shared/${encodeURIComponent(params.widgetName)}`,
    title: params.title,
    strokes: [],
    element: params.node,
  });
  return {
    ...content,
    dataUrl: composeAnnotatedImage({
      image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      strokes: [],
      highlight,
    }),
    fileName: `canvas-${params.widgetName.replace(/[^\w.-]+/g, "-").slice(0, 80) || "element"}.png`,
  };
}
