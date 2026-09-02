import path from "node:path";
// Control UI E2E coverage for legacy WebKit media recovery.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { captureComposerProof } from "./browser-talk-start-stop.fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI browser Talk WebKit errors" });

suite.define(() => {
  it("retries legacy WebKit overconstraints with the system-default microphone", async () => {
    await suite.withPage(undefined, async ({ page }) => {
      const gateway = await installMockGateway(page, { heldMethods: ["talk.client.create"] });
      await page.addInitScript(() => {
        const constraints: MediaStreamConstraints[] = [];
        const track = Object.assign(new EventTarget(), { stop() {} });
        Object.defineProperty(navigator, "mediaDevices", {
          configurable: true,
          value: {
            enumerateDevices: async () => [
              { kind: "audioinput", deviceId: "usb", label: "USB Microphone" },
            ],
            getUserMedia: async (request: MediaStreamConstraints) => {
              constraints.push(request);
              if (constraints.length === 1) {
                throw Object.assign(new Error("Invalid constraint"), {
                  name: "OverconstrainedError",
                  constraint: "",
                });
              }
              return {
                getAudioTracks: () => [track],
                getTracks: () => [track],
              };
            },
          },
        });
        Object.defineProperty(window, "openclawWebKitVoiceConstraints", { value: constraints });
      });

      await page.setViewportSize({ width: 320, height: 720 });
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await page.locator("[data-settings-microphone]").selectOption("usb");
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("button", { name: "Tap to talk" }).click();
      await gateway.waitForRequest("talk.client.create");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (
                window as Window & {
                  openclawWebKitVoiceConstraints?: MediaStreamConstraints[];
                }
              ).openclawWebKitVoiceConstraints,
          ),
        )
        .toEqual([
          {
            audio: {
              autoGainControl: true,
              deviceId: { exact: "usb" },
              echoCancellation: true,
              noiseSuppression: true,
            },
          },
          {
            audio: {
              autoGainControl: true,
              echoCancellation: true,
              noiseSuppression: true,
            },
          },
        ]);
      expect(await gateway.getRequests("talk.client.create")).toHaveLength(1);
      expect(await gateway.getRequests("talk.session.close")).toHaveLength(0);
      await captureComposerProof(suite, page, "webkit-system-default-microphone-recovery.png");
      await page.getByRole("button", { name: "Stop voice input" }).screenshot({
        path: path.join(suite.artifactDir, "voice-controls/webkit-voice-recovered.png"),
      });
      await page.getByRole("button", { name: "Stop voice input" }).click();
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await expect.poll(() => page.locator("[data-settings-microphone]").inputValue()).toBe("");
    });
  });
});
