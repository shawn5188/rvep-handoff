"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Room,
  RoomEvent,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  Track,
  ConnectionState,
} from "livekit-client";
import { getLivekitToken, ApiError } from "@/lib/api-client";
import { ControlChannel, type ControlStats } from "@/lib/control-channel";
import { useWakeLock } from "@/lib/hooks/useWakeLock";
import { usePageVisibilitySafeStop } from "@/lib/hooks/usePageVisibilitySafeStop";
import { Joystick } from "@/components/control/Joystick";
import { ActionButtons } from "@/components/control/ActionButtons";
import { useGamepad } from "@/lib/hooks/useGamepad";
import { GamepadWidget } from "@/components/control/GamepadWidget";
import { SafetyBanner } from "@/components/control/SafetyBanner";
import { RecoveryModal } from "@/components/control/RecoveryModal";
import { CockpitToolbar } from "@/components/control/CockpitToolbar";
import { useCockpitStore } from "@/lib/stores/cockpit-store";
import { useHydrated } from "@/lib/hooks/useHydrated";
import { LocalAudioTrack, createLocalAudioTrack } from "livekit-client";
import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/Stat";
// DJI FPV cockpit chrome
import { HudStatusBar } from "@/components/cockpit/HudStatusBar";
import { StopButton } from "@/components/cockpit/StopButton";
import { TelemetryDrawer } from "@/components/cockpit/TelemetryDrawer";
import { SettingsDrawer } from "@/components/cockpit/SettingsDrawer";
import { RotateHint } from "@/components/cockpit/RotateHint";
import { FullscreenButton } from "@/components/cockpit/FullscreenButton";
import {
  decodeTelemetry,
  decodeSafetyEvent,
  type TelemetryMessage,
  type SafetyEvent,
} from "@rvep/shared";

/**
 * Combined display state derived from {connection, edge-safety} layers.
 * Defines what the UI renders at any given moment.
 */
type DisplayState =
  | "connecting"
  | "active"            // edge sees us, edge is NOT in safe_mode, joystick enabled
  | "safe_locked"       // edge sees us but is in safe_mode, joystick disabled, modal showing
  | "reconnecting"
  | "disconnected"
  | "fatal";

interface VideoTile {
  sid: string;
  identity: string;
  track: RemoteTrack;
}

export default function ControlViewPage() {
  const router = useRouter();
  const params = useParams<{ vehicleId: string }>();
  const vehicleId = params?.vehicleId ?? "";

  const channelRef = useRef<ControlChannel | null>(null);
  // Mirror channelRef in state so consumers re-render when the channel is
  // (re-)created or torn down.
  const [controlChannel, setControlChannel] = useState<ControlChannel | null>(null);
  const [state, setState] = useState<ConnectionState>(ConnectionState.Disconnected);
  const [error, setError] = useState<string | null>(null);
  const [tiles, setTiles] = useState<VideoTile[]>([]);
  const [isLandscape, setIsLandscape] = useState(true);
  const [lastCmd, setLastCmd] = useState<string | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryMessage | null>(null);
  const [telemetryStaleMs, setTelemetryStaleMs] = useState(0);
  const telemetryReceivedAt = useRef(0);
  const [safetyEvent, setSafetyEvent] = useState<SafetyEvent | null>(null);
  const [safetyState, setSafetyState] = useState<"unknown" | "active" | "safe_mode">(
    "unknown",
  );
  const [focusSid, setFocusSid] = useState<string | null>(null);
  const [pttActive, setPttActive] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const pttTrackRef = useRef<LocalAudioTrack | null>(null);
  // Map of tile-sid → live <video> element (registered by VideoTileView via callback ref)
  const videoElsRef = useRef<Map<string, HTMLVideoElement>>(new Map());

  // ── DJI FPV chrome state ────────────────────────────────────────
  const [telemetryDrawerOpen, setTelemetryDrawerOpen] = useState(false);
  const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false);
  // Snapshot of ControlChannel stats — polled at 5 Hz when drawer is open,
  // skipped otherwise to save battery.
  const [controlStats, setControlStats] = useState<ControlStats | null>(null);

  // ── S17 cockpit modes (immersive / standard / mission) ──────────────────
  const hydrated = useHydrated();
  const storedMode = useCockpitStore((s) => s.mode);
  const storedBrightness = useCockpitStore((s) => s.brightness);
  const setCockpitMode = useCockpitStore((s) => s.setMode);
  // Until Zustand persist hydrates from localStorage, fall back to default
  // values so SSR + first paint match.
  const cockpitMode = hydrated ? storedMode : "standard";
  const cockpitBrightness = hydrated ? storedBrightness : "auto";

  // ── S18 mobile safety gates ─────────────────────────────────────────────
  const activeControl =
    state === ConnectionState.Connected && safetyState === "active";

  useWakeLock(activeControl);

  // Gamepad API（C6 加強）— Xbox / PS5 controller 直接驅動 cmd_vel + STOP
  const gamepad = useGamepad({ channel: controlChannel, enabled: activeControl });

  const safeStopBannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (safeStopBannerTimer.current) clearTimeout(safeStopBannerTimer.current);
    },
    [],
  );

  usePageVisibilitySafeStop({
    enabled: activeControl,
    onStop: (reason) => {
      const ch = channelRef.current;
      if (!ch) return;
      ch.sendEmergencyStopSync();
      setLastCmd(`SAFE STOP (${reason})`);
      if (safeStopBannerTimer.current) clearTimeout(safeStopBannerTimer.current);
      safeStopBannerTimer.current = setTimeout(() => setLastCmd(null), 4000);
    },
  });

  useEffect(() => {
    function check() {
      setIsLandscape(window.innerWidth >= window.innerHeight);
    }
    check();
    window.addEventListener("resize", check);
    window.addEventListener("orientationchange", check);
    return () => {
      window.removeEventListener("resize", check);
      window.removeEventListener("orientationchange", check);
    };
  }, []);

  // Tick once per 500 ms so HUD fades to "stale" if telemetry stops arriving.
  useEffect(() => {
    const t = setInterval(() => {
      if (telemetryReceivedAt.current > 0) {
        setTelemetryStaleMs(Date.now() - telemetryReceivedAt.current);
      }
    }, 500);
    return () => clearInterval(t);
  }, []);

  // Poll ControlChannel stats only while drawer is open (battery saving)
  useEffect(() => {
    if (!telemetryDrawerOpen || !controlChannel) {
      // Still keep a single snapshot for when the drawer opens.
      if (controlChannel) setControlStats(controlChannel.getStats());
      return;
    }
    const tick = () => setControlStats(controlChannel.getStats());
    tick();
    const t = setInterval(tick, 200); // 5 Hz
    return () => clearInterval(t);
  }, [telemetryDrawerOpen, controlChannel]);

  useEffect(() => {
    if (!vehicleId) return;

    let cancelled = false;
    const room = new Room();

    const onSub = (
      track: RemoteTrack,
      _pub: RemoteTrackPublication,
      p: RemoteParticipant,
    ) => {
      if (track.kind !== Track.Kind.Video) return;
      setTiles((prev) => {
        const id = track.sid ?? `${p.identity}-${track.kind}`;
        if (prev.some((t) => t.sid === id)) return prev;
        return [...prev, { sid: id, identity: p.identity, track }];
      });
    };

    const onUnsub = (track: RemoteTrack) => {
      setTiles((prev) => prev.filter((t) => t.track !== track));
    };

    const onParticipantLeft = (p: RemoteParticipant) => {
      setTiles((prev) => prev.filter((t) => t.identity !== p.identity));
    };

    const onData = (payload: Uint8Array) => {
      const t = decodeTelemetry(payload);
      if (t && t.vehicleId === vehicleId) {
        telemetryReceivedAt.current = Date.now();
        setTelemetry(t);
        return;
      }
      const s = decodeSafetyEvent(payload);
      if (s && s.vehicleId === vehicleId) {
        setSafetyEvent(s);
        if (s.event === "safe_mode_entered" || s.event === "edge_disconnecting") {
          setSafetyState("safe_mode");
        } else if (s.event === "safe_mode_left") {
          setSafetyState("active");
        } else if (s.event === "edge_online") {
          // informational; wait for safe_mode_left
        } else if (s.event === "fatal") {
          setSafetyState("safe_mode");
        }
      }
    };

    room.on(RoomEvent.ConnectionStateChanged, setState);
    room.on(RoomEvent.TrackSubscribed, onSub);
    room.on(RoomEvent.TrackUnsubscribed, onUnsub);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantLeft);
    room.on(RoomEvent.DataReceived, onData);

    (async () => {
      try {
        const { token, url } = await getLivekitToken(vehicleId, "operator");
        if (cancelled) return;
        await room.connect(url, token);
        if (cancelled) return;
        roomRef.current = room;

        const sessionId = `web-${Date.now()}`;
        const connectionEpoch = Date.now();
        const channel = new ControlChannel(room, vehicleId, sessionId, connectionEpoch);
        channel.startHeartbeat();
        channelRef.current = channel;
        setControlChannel(channel);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          router.replace("/login");
          return;
        }
        setError(err instanceof ApiError ? err.code : "connect_failed");
      }
    })();

    return () => {
      cancelled = true;
      channelRef.current?.stopHeartbeat();
      channelRef.current = null;
      setControlChannel(null);
      if (pttTrackRef.current) {
        pttTrackRef.current.stop();
        pttTrackRef.current = null;
      }
      roomRef.current = null;
      room.disconnect();
    };
  }, [vehicleId, router]);

  async function handleSnapshot(): Promise<number> {
    const vehicleSafe = vehicleId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const ts = new Date()
      .toISOString()
      .replace(/[:T]/g, "-")
      .replace(/\..+$/, "");
    let saved = 0;
    for (const [sid, video] of videoElsRef.current.entries()) {
      if (!video.videoWidth || !video.videoHeight) continue;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((res) =>
        canvas.toBlob(res, "image/png"),
      );
      if (!blob) continue;
      const tile = tiles.find((t) => t.sid === sid);
      const identity = tile?.identity?.replace(/[^a-zA-Z0-9_-]/g, "_") ?? "cam";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `rvep-${vehicleSafe}-${identity}-${ts}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      saved += 1;
    }
    return saved;
  }

  async function handlePTTStart() {
    if (pttTrackRef.current) return;
    const room = roomRef.current;
    if (!room) return;
    try {
      const track = await createLocalAudioTrack({
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      });
      pttTrackRef.current = track;
      await room.localParticipant.publishTrack(track, {
        name: "operator-ptt",
      });
      setPttActive(true);
    } catch (err) {
      console.warn("PTT start failed", err);
      pttTrackRef.current?.stop();
      pttTrackRef.current = null;
      setPttActive(false);
    }
  }

  async function handlePTTEnd() {
    setPttActive(false);
    const track = pttTrackRef.current;
    if (!track) return;
    pttTrackRef.current = null;
    try {
      const room = roomRef.current;
      if (room) {
        await room.localParticipant.unpublishTrack(track);
      }
    } catch (err) {
      console.warn("PTT unpublish failed", err);
    } finally {
      track.stop();
    }
  }

  const registerVideoEl = (sid: string, el: HTMLVideoElement | null) => {
    if (el) {
      videoElsRef.current.set(sid, el);
    } else {
      videoElsRef.current.delete(sid);
    }
  };

  function emergencyStop() {
    const channel = channelRef.current;
    if (!channel) {
      setError("not_connected");
      return;
    }
    // Synchronous: hand to RTC stack inside this tick to beat OS freeze.
    channel.sendEmergencyStopSync();
    setLastCmd("EMERGENCY_STOP 已送出");
    if (safeStopBannerTimer.current) clearTimeout(safeStopBannerTimer.current);
    safeStopBannerTimer.current = setTimeout(() => setLastCmd(null), 3000);
  }

  const connected = state === ConnectionState.Connected;
  const connecting =
    state === ConnectionState.Connecting || state === ConnectionState.Reconnecting;

  // Derived 5-stage display state combining {Livekit connection, edge safety}.
  const displayState: DisplayState = (() => {
    if (state === ConnectionState.Disconnected) return "disconnected";
    if (state === ConnectionState.Connecting) return "connecting";
    if (
      state === ConnectionState.Reconnecting ||
      state === ConnectionState.SignalReconnecting
    )
      return "reconnecting";
    if (safetyState === "active") return "active";
    return "safe_locked";
  })();

  const joystickEnabled = displayState === "active";
  const stateTone =
    displayState === "active"
      ? "online"
      : displayState === "safe_locked"
        ? "warning"
        : connecting
          ? "warning"
          : "offline";
  const stateLabel: Record<DisplayState, string> = {
    connecting: "連線中",
    active: "正常控制",
    safe_locked: "安全模式",
    reconnecting: "重連中",
    disconnected: "未連線",
    fatal: "需介入",
  };

  // Latency proxy for HUD LINK indicator — prefer network RTT, fall back to
  // last-cmd-ago which reflects DataChannel responsiveness.
  const connLatencyMs =
    telemetry?.network?.rttMs ??
    (controlStats && controlStats.lastCmdAgoMs !== Number.POSITIVE_INFINITY
      ? controlStats.lastCmdAgoMs
      : null);

  // SafetyBanner visibility — duplicates SafetyBanner's internal logic so we
  // can shift the HUD pill down when the banner pushes content. SafetyBanner
  // returns null when state === "active".
  const safetyBannerVisible = displayState !== "active";

  async function handleResume(): Promise<boolean> {
    const channel = channelRef.current;
    if (!channel) return false;
    try {
      await channel.sendResume();
      return true;
    } catch {
      return false;
    }
  }

  if (!isLandscape) {
    return (
      <>
        <RotateHint />
        <PortraitFallback
          vehicleId={vehicleId}
          tiles={tiles}
          stateTone={stateTone}
          stateLabel={stateLabel[displayState]}
          error={error}
          lastCmd={lastCmd}
          onBack={() => router.push("/vehicles")}
          onEmergency={emergencyStop}
        />
      </>
    );
  }

  return (
    <main
      data-cockpit-mode={cockpitMode}
      data-brightness={cockpitBrightness}
      className="fixed inset-0 bg-black overflow-hidden"
      style={{
        // Dynamic viewport so iOS Safari URL bar collapsing doesn't leave a gap.
        width: "100dvw",
        height: "100dvh",
      }}
    >
      {/* Skip-to-STOP for keyboard users (invisible until focused). */}
      <a
        href="#emergency-stop-btn"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:px-4 focus:py-2 focus:rounded-lg focus:bg-[var(--accent-red)] focus:text-white focus:font-bold focus:text-sm focus:shadow-lg"
      >
        跳至緊急停止
      </a>

      {/* RotateHint — fullscreen overlay if rotated portrait while in cockpit */}
      <RotateHint />

      {/* ── Layer 0: Video full-bleed (under everything) ──────────────────── */}
      <section
        className={`absolute inset-0 ${
          focusSid ? "flex" : "grid grid-cols-1 md:grid-cols-2"
        } gap-1`}
        data-testid="video-grid"
      >
        {tiles.length === 0 && (
          <div className="col-span-full flex items-center justify-center text-neutral-600 bg-black">
            <div className="flex flex-col items-center gap-3">
              <div className="h-12 w-12 rounded-full border-2 border-neutral-800 border-t-neutral-500 animate-spin" />
              <span className="text-sm">等待視訊串流…</span>
            </div>
          </div>
        )}
        {tiles
          .filter((t) => (focusSid ? t.sid === focusSid : true))
          .map((tile) => (
            <VideoTileView
              key={tile.sid}
              tile={tile}
              focused={focusSid === tile.sid}
              onToggleFocus={() =>
                setFocusSid(focusSid === tile.sid ? null : tile.sid)
              }
              registerVideoEl={registerVideoEl}
            />
          ))}
      </section>

      {/* ── Layer 1: Safety banners (top, full-width strips) ──────────────── */}
      <div className="pointer-events-none fixed left-0 right-0 z-30" style={{ top: "max(0rem, env(safe-area-inset-top))" }}>
        <div className="pointer-events-auto">
          <SafetyBanner
            safetyState={
              displayState === "disconnected" || displayState === "reconnecting"
                ? "lost"
                : displayState === "active"
                  ? "active"
                  : safetyState === "unknown" && connected
                    ? "unknown"
                    : "safe_mode"
            }
            reason={safetyEvent?.reason}
            lastEvent={safetyEvent?.event}
          />
        </div>
      </div>

      {/* ── Layer 1: L1 常駐 HUD status bar (top-center) ──────────────────── */}
      <HudStatusBar
        telemetry={telemetry}
        staleMs={telemetryStaleMs}
        connLatencyMs={connLatencyMs}
        onExpand={() => setTelemetryDrawerOpen((v) => !v)}
        expanded={telemetryDrawerOpen}
        topOffsetPx={safetyBannerVisible ? 40 : 0}
      />

      {/* ── Layer 1: STOP — top-right corner, opposite the back chevron ────
          Sits 48px in from the right edge to give FullscreenButton (top-3 right-3,
          32×32) its own breathing room next to it. STOP stays in the top-right
          half so right-thumb can hit it without crossing the screen. */}
      <div
        className="pointer-events-none fixed z-40 flex items-center gap-2"
        style={{
          top: `calc(max(0.5rem, env(safe-area-inset-top)) + ${safetyBannerVisible ? 40 : 0}px)`,
          right: "calc(max(0.75rem, env(safe-area-inset-right)) + 2.75rem)",
        }}
      >
        <StopButton onStop={emergencyStop} />
      </div>

      {/* ── Layer 1: Settings gear (top-left, drives SettingsDrawer) ──────── */}
      <div
        className="pointer-events-none fixed z-40 flex items-center gap-2"
        style={{
          top: `calc(max(0.5rem, env(safe-area-inset-top)) + ${safetyBannerVisible ? 40 : 0}px)`,
          left: "max(0.75rem, env(safe-area-inset-left))",
        }}
      >
        <button
          type="button"
          onClick={() => setSettingsDrawerOpen(true)}
          aria-label="駕駛艙設定"
          title="駕駛艙設定（模式 / 亮度 / 返回 Fleet）"
          data-testid="settings-trigger"
          className="pointer-events-auto h-11 w-11 rounded-full bg-black/55 border border-white/15 backdrop-blur-md text-neutral-200 hover:bg-black/75 hover:text-white active:scale-95 transition flex items-center justify-center"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9 1.65 1.65 0 0 0 4.27 7.18l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        {/* Fullscreen — overlaps with FullscreenButton's own top-3 right-3
            placement, so render here for visual rhythm with the gear. */}
      </div>

      {/* FullscreenButton self-positions at top-3 right-3 (its own fixed
          chrome). It will sit underneath the STOP button (z-40 > z-30) on iPad
          where both exist; on iPhone the device kind is "iphone" and it
          renders an A2HS overlay instead, no clash. Leaving it untouched is
          required (separate-agent territory per spec). */}
      <FullscreenButton />

      {/* Toast strip — error + lastCmd live below HUD bar. Pulled out of video
          grid so they never push joystick. */}
      <div
        className="pointer-events-none fixed left-1/2 -translate-x-1/2 z-40"
        style={{
          top: `calc(max(0.5rem,env(safe-area-inset-top)) + ${safetyBannerVisible ? 40 : 0}px + 3rem)`,
        }}
      >
        {error && (
          <div
            className="px-4 py-2 rounded-full bg-[var(--accent-red)]/30 border border-[var(--accent-red)]/60 text-sm text-[var(--accent-red)] backdrop-blur"
            data-testid="error-banner"
          >
            連線錯誤：{error}
          </div>
        )}
        {lastCmd && !error && (
          <div
            className="px-4 py-2 rounded-full bg-[var(--accent-amber)]/25 border border-[var(--accent-amber)]/60 text-sm text-[var(--accent-amber)] backdrop-blur whitespace-nowrap"
            data-testid="cmd-toast"
          >
            ✓ {lastCmd}
          </div>
        )}
      </div>

      {/* ── Layer 1: Left thumb — Joystick (bottom-left) ─────────────────── */}
      <div
        className="pointer-events-auto fixed z-40"
        style={{
          left: "max(1.5rem, env(safe-area-inset-left))",
          bottom: "max(1.5rem, env(safe-area-inset-bottom))",
        }}
      >
        <Joystick
          disabled={!joystickEnabled}
          onChange={(axes) => {
            channelRef.current?.sendMovement(axes).catch(() => {});
          }}
          onRelease={() => {
            channelRef.current
              ?.sendMovement({ forward: 0, lateral: 0, yaw: 0 })
              .catch(() => {});
          }}
        />
      </div>

      {/* ── Layer 1: Right thumb — MOBA action cluster (bottom-right) ────── */}
      {/* 傳說對決 layout: 1 large forward button + arc of 3 small buttons
          (back / turn-left / turn-right). Mirrors the Joystick under the left
          thumb so both hands stay anchored in landscape. */}
      <div
        className="pointer-events-auto fixed z-40"
        style={{
          right: "max(1.5rem, env(safe-area-inset-right))",
          bottom: "max(1.5rem, env(safe-area-inset-bottom))",
        }}
      >
        <ActionButtons
          disabled={!joystickEnabled}
          onPress={(axes) => {
            channelRef.current?.sendMovement(axes).catch(() => {});
          }}
          onRelease={() => {
            channelRef.current
              ?.sendMovement({ forward: 0, lateral: 0, yaw: 0 })
              .catch(() => {});
          }}
        />
      </div>

      {/* ── Layer 1: view focus toggle — moved above the action cluster and
          shrunk (h-9) now that the MOBA buttons own the bottom-right corner. */}
      {tiles.length > 1 && (
        <div
          className="pointer-events-auto fixed z-40"
          style={{
            right: "max(1.5rem, env(safe-area-inset-right))",
            bottom: "calc(max(1.5rem, env(safe-area-inset-bottom)) + 12.5rem)",
          }}
        >
          <button
            type="button"
            onClick={() => setFocusSid(focusSid ? null : tiles[0]?.sid ?? null)}
            aria-label={focusSid ? "返回多鏡頭網格" : "放大第一鏡頭"}
            title={focusSid ? "返回多鏡頭網格" : "放大第一鏡頭"}
            className="h-9 w-9 rounded-full bg-black/60 border border-white/20 backdrop-blur-md text-white text-base flex items-center justify-center hover:bg-black/80 active:scale-95 transition"
            data-testid="focus-toggle"
          >
            {focusSid ? "▦" : "⤢"}
          </button>
        </div>
      )}

      {/* ── Layer 2: Gamepad widget (only when connected) ─────────────────── */}
      {gamepad.connected && (
        <div
          className="pointer-events-auto fixed z-30"
          style={{
            right: "calc(max(1.5rem, env(safe-area-inset-right)) + 4rem)",
            bottom: "calc(max(1.5rem, env(safe-area-inset-bottom)) + 12.5rem)",
          }}
          data-cockpit-layer="L2"
        >
          <GamepadWidget gamepad={gamepad} compact />
        </div>
      )}

      {/* ── Layer 2: Bottom toolbar — snapshot + PTT (centered) ───────────── */}
      <div data-cockpit-layer="L2" className="pointer-events-none">
        <CockpitToolbar
          onSnapshot={handleSnapshot}
          onPTTStart={handlePTTStart}
          onPTTEnd={handlePTTEnd}
          pttActive={pttActive}
          disabled={displayState !== "active"}
        />
      </div>

      {/* ── Layer 2: Telemetry drawer (top, expandable) ───────────────────── */}
      <TelemetryDrawer
        open={telemetryDrawerOpen}
        onClose={() => setTelemetryDrawerOpen(false)}
        telemetry={telemetry}
        staleMs={telemetryStaleMs}
        controlStats={controlStats}
        channelConnected={state === ConnectionState.Connected}
        gamepadConnected={gamepad.connected}
        gamepadName={gamepad.gamepadName}
      />

      {/* ── Layer 3: Settings drawer (right, slides in) ───────────────────── */}
      <SettingsDrawer
        open={settingsDrawerOpen}
        onClose={() => setSettingsDrawerOpen(false)}
        onBackToFleet={() => router.push("/vehicles")}
        vehicleId={vehicleId}
        tileCount={tiles.length}
        stateLabel={stateLabel[displayState]}
      />

      {/* ── Recovery modal (full-screen interstitial in safe_locked) ──────── */}
      <RecoveryModal
        open={displayState === "safe_locked"}
        reason={safetyEvent?.reason}
        onConfirm={handleResume}
      />

      {/* Connection state chip — bottom-center thin pill so operator always
          knows whether they're 連線中 / 正常控制 / 重連中 without opening drawer.
          Sits just above CockpitToolbar; only visible in immersive too since
          this is a critical safety indicator (not L2). */}
      <div
        className="pointer-events-none fixed left-1/2 -translate-x-1/2 z-30"
        style={{ bottom: "calc(max(1.5rem,env(safe-area-inset-bottom)) + 4.25rem)" }}
        data-testid="conn-state-chip-wrap"
      >
        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-black/55 border border-white/15 backdrop-blur-md text-[10px] tracking-[0.2em] uppercase">
          <StatusDot tone={stateTone} />
          <span className="text-neutral-200" data-testid="conn-state">
            {stateLabel[displayState]}
          </span>
        </div>
      </div>

      {/* P0-mobile fix (2026-05-20): Immersive 模式藏 L2/L3 → 手機沒鍵盤無法切回。
       *  保留浮動退出按鈕避免使用者被困。 */}
      {cockpitMode === "immersive" && (
        <button
          type="button"
          onClick={() => setCockpitMode("standard")}
          aria-label="退出 Immersive 模式，回到 Standard"
          title="退出 Immersive (回 Standard)"
          data-testid="exit-immersive-btn"
          className="fixed top-16 right-3 z-50 h-9 w-9 rounded-full bg-black/70 border border-white/25 text-white text-sm flex items-center justify-center backdrop-blur hover:bg-black/85 active:scale-95 transition shadow-lg"
        >
          ⤢
        </button>
      )}
    </main>
  );
}

interface TileStats {
  fps: number;
  width: number;
  height: number;
  g2gMs: number;
  haveCaptureTime: boolean;
}

interface VideoFrameMetadataExt {
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  captureTime?: number;
  receiveTime?: number;
  processingDuration?: number;
  rtpTimestamp?: number;
}

function VideoTileView({
  tile,
  focused = false,
  onToggleFocus,
  registerVideoEl,
}: {
  tile: VideoTile;
  focused?: boolean;
  onToggleFocus?: () => void;
  registerVideoEl?: (sid: string, el: HTMLVideoElement | null) => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  const [stats, setStats] = useState<TileStats | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    tile.track.attach(el);
    registerVideoEl?.(tile.sid, el);
    return () => {
      registerVideoEl?.(tile.sid, null);
      tile.track.detach(el);
    };
  }, [tile.track]);

  // Use requestVideoFrameCallback (Chrome/Edge/Safari 16+) to read per-frame
  // metadata: captureTime (sender side, abs-capture-time RTP ext) and receiveTime.
  useEffect(() => {
    const el = ref.current as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        cb: (now: number, meta: VideoFrameMetadataExt) => void,
      ) => number;
    };
    if (!el) return;
    if (typeof el.requestVideoFrameCallback !== "function") return;

    let stopped = false;
    let frameStamps: number[] = [];
    let g2gSamples: number[] = [];
    let haveCapture = false;
    let lastUpdate = 0;

    const cb = (now: number, meta: VideoFrameMetadataExt) => {
      if (stopped) return;

      frameStamps.push(now);
      while (frameStamps.length && now - frameStamps[0] > 1000) frameStamps.shift();

      let g2g = 0;
      if (typeof meta.captureTime === "number" && meta.captureTime > 0) {
        g2g = now - meta.captureTime;
        haveCapture = true;
      } else if (typeof meta.receiveTime === "number" && meta.receiveTime > 0) {
        g2g = now - meta.receiveTime;
      }
      if (g2g > 0 && g2g < 5000) {
        g2gSamples.push(g2g);
        if (g2gSamples.length > 30) g2gSamples.shift();
      }

      if (now - lastUpdate > 500) {
        lastUpdate = now;
        const avgG2G = g2gSamples.length
          ? g2gSamples.reduce((a, b) => a + b, 0) / g2gSamples.length
          : 0;
        setStats({
          fps: frameStamps.length,
          width: meta.width ?? 0,
          height: meta.height ?? 0,
          g2gMs: avgG2G,
          haveCaptureTime: haveCapture,
        });
      }

      el.requestVideoFrameCallback?.(cb);
    };
    el.requestVideoFrameCallback?.(cb);

    return () => {
      stopped = true;
    };
  }, [tile.track]);

  return (
    <div
      className="relative w-full h-full min-h-0 overflow-hidden bg-black group"
      data-testid={`tile-${tile.identity}`}
      data-focused={focused ? "true" : undefined}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        onDoubleClick={onToggleFocus}
        className="w-full h-full object-cover bg-black cursor-zoom-in"
      />
      {/* Tile identity badge — top-right corner so it doesn't clash with HUD bar */}
      <div
        className="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-1 rounded-full bg-black/55 backdrop-blur-md border border-white/15 pointer-events-none"
        data-cockpit-layer="L2"
      >
        <StatusDot tone="online" />
        <span className="text-[10px] text-neutral-200 tracking-[0.12em] uppercase">{tile.identity}</span>
      </div>
      {/* Per-tile stats — small, bottom-left, Mission mode only */}
      {stats && (
        <div
          className="absolute bottom-3 left-3 px-2 py-1 rounded-md bg-black/55 backdrop-blur border border-white/10 text-[10px] font-mono leading-tight cockpit pointer-events-none"
          data-testid={`stats-${tile.identity}`}
          data-cockpit-layer="L3"
        >
          <div className="text-neutral-300">
            {stats.width}×{stats.height} · {stats.fps} fps
          </div>
          <div
            className={
              stats.g2gMs < 80
                ? "text-emerald-400"
                : stats.g2gMs < 150
                  ? "text-amber-400"
                  : "text-red-400"
            }
            title="接收端延遲：jitter buffer + decode + render。不含 sender 端 encode 跟網路傳輸（真實 G2G ≈ 此值 + 200ms）"
          >
            {stats.g2gMs.toFixed(0)} ms <span className="text-[9px] text-neutral-500">(recv)</span>
          </div>
        </div>
      )}
    </div>
  );
}

interface PortraitProps {
  vehicleId: string;
  tiles: VideoTile[];
  stateTone: "online" | "offline" | "warning" | "danger";
  stateLabel: string;
  error: string | null;
  lastCmd: string | null;
  onBack: () => void;
  onEmergency: () => void;
}

function PortraitFallback({
  vehicleId,
  tiles,
  stateTone,
  stateLabel,
  error,
  lastCmd,
  onBack,
  onEmergency,
}: PortraitProps) {
  return (
    <main className="min-h-screen flex flex-col bg-black">
      <header className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)]">
        <Button variant="ghost" size="sm" onClick={onBack}>
          ← Fleet
        </Button>
        <span className="text-sm font-medium cockpit">{vehicleId}</span>
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/40 border border-[var(--border-subtle)]">
          <StatusDot tone={stateTone} />
          <span className="text-xs text-neutral-300">{stateLabel}</span>
        </div>
      </header>

      <div className="px-4 py-2 text-xs text-amber-400 bg-amber-500/10 border-b border-amber-500/20">
        ⤺ 建議將裝置橫向旋轉以獲得最佳控制體驗
      </div>

      <section className="flex-1 grid grid-cols-1 gap-2 p-2 bg-black" data-testid="video-grid">
        {tiles.length === 0 && (
          <div className="flex items-center justify-center text-neutral-600 min-h-[40vh]">
            <span className="text-sm">等待視訊串流…</span>
          </div>
        )}
        {tiles.map((tile) => (
          <VideoTileView key={tile.sid} tile={tile} />
        ))}
      </section>

      {lastCmd && (
        <div className="px-4 py-2 bg-amber-500/10 border-t border-amber-500/40 text-sm text-amber-400 text-center" data-testid="cmd-toast">
          ✓ {lastCmd}
        </div>
      )}
      {error && (
        <div
          className="px-4 py-2 bg-[var(--accent-red)]/10 border-t border-[var(--accent-red)]/40 text-sm text-[var(--accent-red)]"
          data-testid="error-banner"
        >
          連線錯誤：{error}
        </div>
      )}

      <footer className="p-4 border-t border-[var(--border-subtle)]">
        <Button
          onClick={onEmergency}
          variant="danger"
          size="xl"
          className="w-full text-base font-bold tracking-[0.15em] uppercase"
          data-testid="emergency-stop"
        >
          Emergency Stop
        </Button>
      </footer>
    </main>
  );
}
