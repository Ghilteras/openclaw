import type { CDPSession } from "playwright-core";
import type { CdpSendFn } from "./cdp.helpers.js";

/** Bind Playwright's protocol-generic sender to the browser's raw CDP contract. */
export function bindPlaywrightCdpSend(session: CDPSession): CdpSendFn {
  // SAFETY: Playwright's generic overload accepts the same method/params calls; binding preserves its receiver.
  const send = session.send.bind(session) as unknown as CdpSendFn;
  return (method, params) => send(method, params);
}
