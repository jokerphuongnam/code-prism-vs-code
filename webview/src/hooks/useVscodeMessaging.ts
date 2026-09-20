import { useEffect, useCallback } from "react";
import type { HostToWebviewMessage, WebviewToHostMessage } from "../protocol";

interface VscodeApi {
  postMessage(message: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VscodeApi;

const vscode = acquireVsCodeApi();

export function useVscodeMessaging(
  onMessage: (msg: HostToWebviewMessage) => void
) {
  useEffect(() => {
    const handler = (event: MessageEvent<HostToWebviewMessage>) => {
      try {
        onMessage(event.data);
      } catch (err) {
        console.error("[SwiftPrism] Message handler error:", err);
      }
    };
    window.addEventListener("message", handler);
    vscode.postMessage({ type: "ready" });
    return () => window.removeEventListener("message", handler);
  }, [onMessage]);
}

export function usePostMessage() {
  return useCallback((msg: WebviewToHostMessage) => {
    vscode.postMessage(msg);
  }, []);
}
