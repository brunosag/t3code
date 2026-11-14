import { useSyncExternalStore } from "react";

import { resolveBrowserLayoutZoomFactor } from "./browserViewportLayout";

// App zoom changes the CSS viewport, so resize also signals zoom changes.
const subscribeToWindowZoom = (onChange: () => void) => {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
};
const readWindowZoomFactor = () => window.desktopBridge?.getWindowZoomFactor() ?? 1;

export function useWindowZoomFactor() {
  return useSyncExternalStore(subscribeToWindowZoom, readWindowZoomFactor);
}

export function useBrowserLayoutZoomFactor(previewZoomFactor: number) {
  return resolveBrowserLayoutZoomFactor(previewZoomFactor, useWindowZoomFactor());
}
