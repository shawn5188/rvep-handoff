"use client";

import { useCallback, useEffect, useState } from "react";
import { useHydrated } from "@/lib/hooks/useHydrated";

type DeviceKind = "iphone" | "ipad" | "standalone" | "other";

// iPadOS 13+ reports UA as Macintosh; disambiguate via touch points.
function detectDevice(): DeviceKind {
  if (typeof window === "undefined") return "other";
  const nav = window.navigator;
  // Cast: `standalone` is iOS-only and not in standard Navigator type.
  const iosStandalone = (nav as Navigator & { standalone?: boolean }).standalone;
  const displayStandalone =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  if (iosStandalone || displayStandalone) return "standalone";

  const ua = nav.userAgent || "";
  if (/iPhone/.test(ua)) return "iphone";
  if (/iPad/.test(ua)) return "ipad";
  // iPadOS 13+ mimics Mac UA but exposes >2 touch points.
  if (nav.maxTouchPoints > 2 && /Macintosh/.test(ua)) return "ipad";
  return "other";
}

interface OrientationLock {
  lock: (orientation: "landscape") => Promise<void>;
}

export function FullscreenButton() {
  const hydrated = useHydrated();
  const [device, setDevice] = useState<DeviceKind>("other");
  const [showA2HS, setShowA2HS] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    setDevice(detectDevice());
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const onClick = useCallback(() => {
    if (device === "iphone") {
      setShowA2HS(true);
      return;
    }
    if (device === "ipad" || device === "other") {
      if (document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {});
        return;
      }
      const el = document.documentElement;
      const req = el.requestFullscreen?.bind(el);
      if (!req) return;
      void req()
        .then(() => {
          // Best-effort orientation lock; ignored on iPad Safari which lacks support.
          const orientation = (screen as Screen & { orientation?: OrientationLock })
            .orientation;
          if (orientation && typeof orientation.lock === "function") {
            void orientation.lock("landscape").catch(() => {});
          }
        })
        .catch(() => {});
    }
  }, [device]);

  if (!hydrated || device === "standalone") return null;

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-label={
          device === "iphone"
            ? "顯示加入主畫面教學"
            : isFullscreen
              ? "退出全螢幕"
              : "進入全螢幕"
        }
        title={device === "iphone" ? "加入主畫面以全螢幕" : "全螢幕"}
        data-testid="fullscreen-button"
        className="fixed top-3 right-3 z-30 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-black/50 text-white backdrop-blur transition-colors hover:bg-black/70"
      >
        <span aria-hidden="true" className="text-base leading-none">
          {isFullscreen ? "⤡" : "⛶"}
        </span>
      </button>
      {showA2HS && device === "iphone" && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="加入主畫面教學"
          data-testid="a2hs-overlay"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-6"
          onClick={() => setShowA2HS(false)}
        >
          <div
            className="max-w-sm rounded-2xl border border-white/10 bg-neutral-950 p-6 text-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-base font-semibold tracking-wide">
              將 RVEP 加入主畫面以進入全螢幕
            </h2>
            <ol className="space-y-3 text-sm leading-relaxed text-neutral-200">
              <li>
                <span className="mr-2 font-semibold text-white">①</span>
                點擊 Safari 底部「分享」鈕
                <span className="ml-1 text-neutral-400">(􀈂)</span>
              </li>
              <li>
                <span className="mr-2 font-semibold text-white">②</span>
                選擇「加入主畫面 / Add to Home Screen」
              </li>
              <li>
                <span className="mr-2 font-semibold text-white">③</span>
                之後從主畫面 RVEP 圖示啟動即可全螢幕
              </li>
            </ol>
            <button
              type="button"
              onClick={() => setShowA2HS(false)}
              className="mt-6 w-full rounded-full border border-white/20 px-4 py-2 text-xs uppercase tracking-widest text-neutral-200 hover:bg-white/10"
            >
              知道了
            </button>
          </div>
        </div>
      )}
    </>
  );
}
