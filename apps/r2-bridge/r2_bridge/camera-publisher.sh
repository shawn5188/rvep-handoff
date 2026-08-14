#!/usr/bin/env bash
# r2-camera-publisher — C270 → VAAPI H.264 → LiveKit room
#
# Pipeline (proven 2026-05-22 after long debug):
#   v4l2src → videoconvert → vaapih264enc (i965 driver, Apollo Lake EncSlice
#     path, NOT EncSliceLP/VDEnc which requires HuC microcode authorization)
#   → h264parse → fdsink fd=1
#   → socat stdin → UNIX-LISTEN socket
#   → lk room join --publish=h264:///socket → LiveKit SFU
#
# Why this dance (Apollo Lake N3350 specific):
# - iHD driver's VDEnc path needs HuC microcode authorization (kernel
#   i915.enable_guc=2) which isn't enabled by default — see
#   [[project-r2-vaapi-huc-blocker]] memory.
# - i965-va-driver-shaders avoids VDEnc, uses stable EncSlice path.
# - filesink → FIFO + lk reader fails caps negotiation (cat reader works,
#   lk reader doesn't, root cause not isolated). Workaround: fdsink |
#   socat → UNIX socket → lk publish.
#
# Reads config from /etc/rvep/r2-camera.env.

set -e

: "${LIVEKIT_URL:?LIVEKIT_URL required}"
: "${LIVEKIT_API_KEY:?LIVEKIT_API_KEY required}"
: "${LIVEKIT_API_SECRET:?LIVEKIT_API_SECRET required}"
: "${ROOM:?ROOM required}"
: "${IDENTITY:=r2-camera}"
: "${FPS:=30}"
: "${BITRATE:=1500}"
: "${DEVICE:=/dev/video0}"

# VAAPI driver lock — see project memory for why iHD doesn't work.
export LIBVA_DRIVER_NAME=i965
export LIBVA_DRIVERS_PATH=/usr/lib/x86_64-linux-gnu/dri

SOCK=/tmp/r2cam.sock
rm -f "$SOCK"

trap 'jobs -p | xargs -r kill 2>/dev/null; rm -f "$SOCK"; exit' EXIT INT TERM

# Pipeline 1: GStreamer encodes to stdout, socat serves UNIX socket
# IMPORTANT: bare pipeline, no explicit downstream caps. Auto-negotiation
# is the ONLY mode that works on Apollo Lake + i965 + systemd context.
( gst-launch-1.0 -q \
      v4l2src device="$DEVICE" \
    ! videoconvert \
    ! vaapih264enc \
    ! h264parse \
    ! fdsink fd=1 \
  | socat - UNIX-LISTEN:"$SOCK",fork,reuseaddr ) &
PIPE_PID=$!

# Wait for UNIX socket to appear (socat creates it when gst starts writing)
for i in 1 2 3 4 5 6 7 8 9 10; do
  [ -S "$SOCK" ] && break
  sleep 0.5
done

if [ ! -S "$SOCK" ]; then
  echo "ERROR: socket $SOCK never appeared" >&2
  exit 2
fi

# lk CLI honors LIVEKIT_TOKEN env var over --api-key/--api-secret; if this
# script is sourced alongside r2-bridge's env (e.g. manual debug), the bridge
# JWT would leak in and camera would try to join with the wrong identity.
# (cherry-picked from gluttonyOwO@bf761fef)
unset LIVEKIT_TOKEN

# Pipeline 2: lk reads from UNIX socket, publishes to LiveKit room
exec lk room join \
  --url "$LIVEKIT_URL" \
  --api-key "$LIVEKIT_API_KEY" \
  --api-secret "$LIVEKIT_API_SECRET" \
  --identity "$IDENTITY" \
  --publish "h264:///$SOCK" \
  --fps "$FPS" \
  "$ROOM"
