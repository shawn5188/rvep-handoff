"use client";

import { useEffect, useState } from "react";
import { useHydrated } from "@/lib/hooks/useHydrated";

/**
 * Fullscreen overlay shown when the device is held in portrait orientation.
 * Covers iPhone (no Fullscreen API) and iPad (which may also be held upright).
 * Hidden once the user rotates to landscape.
 */
export function RotateHint() {
  const hydrated = useHydrated();
  const [isPortrait, setIsPortrait] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(orientation: portrait)");
    const update = () => setIsPortrait(mq.matches);
    update();
    // Safari < 14 lacks addEventListener on MediaQueryList.
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", update);
      return () => mq.removeEventListener("change", update);
    }
    mq.addListener(update);
    return () => mq.removeListener(update);
  }, []);

  if (!hydrated || !isPortrait) return null;

  return (
    <div
      role="alert"
      aria-live="polite"
      data-testid="rotate-hint"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-black text-white px-8 text-center"
    >
      <div className="text-6xl leading-none" aria-hidden="true">
        ⤺
      </div>
      <p className="text-lg font-medium tracking-wide">
        請將手機橫拿以進入駕駛艙
      </p>
      <p className="text-xs uppercase tracking-[0.3em] text-neutral-400">
        Rotate device to landscape
      </p>
    </div>
  );
}
