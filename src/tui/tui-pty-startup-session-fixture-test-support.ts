// Injects delayed session restore and history controls into the real-runTui PTY fixture.
export const TUI_PTY_STARTUP_SESSION_FIXTURE = {
  variables: `
      let startupHistoryHeld = process.env.OPENCLAW_TUI_PTY_HOLD_STARTUP_HISTORY === "1";
      const restoreDelayMs = Number(process.env.OPENCLAW_TUI_PTY_RESTORE_DELAY_MS ?? 0);
      const restoreFailures = Number(process.env.OPENCLAW_TUI_PTY_RESTORE_FAILURES ?? 0);
      const reconnectHistoryDelayMs = Number(
        process.env.OPENCLAW_TUI_PTY_RECONNECT_HISTORY_DELAY_MS ?? 0,
      );
      let restoreAttempts = 0;
      let reconnectDuringRestore = process.env.OPENCLAW_TUI_PTY_RECONNECT_DURING_RESTORE === "1";
  `,
  loadHistory: `
          if (startupHistoryHeld) {
            record("startupHistoryPending", { sessionKey });
            await waitForFixtureRelease("startup-history");
            startupHistoryHeld = false;
            record("startupHistoryReleased", { sessionKey });
          }
          if (reconnectHistoryReady && reconnectHistoryDelayMs > 0) {
            reconnectHistoryReady = false;
            record("reconnectHistoryPending", { sessionKey });
            await new Promise((resolve) => setTimeout(resolve, reconnectHistoryDelayMs));
          }
  `,
  listSessionsSetup: `
          const isRestore = Boolean(opts?.search);
  `,
  listSessionsDelay: `
          if (isRestore && reconnectDuringRestore) {
            reconnectDuringRestore = false;
            record("restoreReconnect");
            this.onDisconnected?.("fixture reconnect during restore");
            queueMicrotask(() => this.onConnected?.());
          }
          if (isRestore && restoreDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, restoreDelayMs));
          }
          if (isRestore && restoreAttempts++ < restoreFailures) {
            throw new Error("fixture remembered-session lookup failed");
          }
  `,
} as const;
