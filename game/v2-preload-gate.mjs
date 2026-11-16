/**
 * V2-only single-flight image preloading and verification.
 * Original game rules and screens are not changed.
 */
import { prepareImageAssets, ensureImageCacheWorker } from "./preload-images.mjs";
let preparation;
export function ensureV2ImageCache(onProgress = () => {}) {
  if (!preparation) {
    preparation = (async () => {
      const summary = await prepareImageAssets(onProgress);
      await ensureImageCacheWorker(summary.version);
      return summary;
    })();
    // A failed attempt must remain retryable through the original Connect button.
    const inFlight = preparation;
    void inFlight.catch(() => {
      if (preparation === inFlight) preparation = undefined;
    });
  }
  return preparation;
}
