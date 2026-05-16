#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export LLMHQ_CHATGPT_HEADLESS=0

mkdir -p /tmp/llmhq-vnc

if [ ! -S "/tmp/.X11-unix/X${DISPLAY#:}" ]; then
  Xvfb "$DISPLAY" -screen 0 1440x1100x24 -ac +extension RANDR >/tmp/llmhq-vnc/xvfb.log 2>&1 &
  sleep 1
fi

x11vnc -display "$DISPLAY" -nopw -forever -shared -rfbport 5900 -bg -o /tmp/llmhq-vnc/x11vnc.log >/dev/null 2>&1 || true

if ! pgrep -f "websockify.*7900" >/dev/null 2>&1; then
  websockify --web=/usr/share/novnc/ 7900 localhost:5900 >/tmp/llmhq-vnc/websockify.log 2>&1 &
  sleep 1
fi

cat <<'EOF'

ChatGPT login browser is available at:
  http://127.0.0.1:7900/vnc.html?autoconnect=1&resize=scale

Open that URL in your normal browser, log into ChatGPT with Google, then return
to this terminal and press Enter when the ChatGPT prompt box is usable.

EOF

node scripts/chatgpt-login.js
