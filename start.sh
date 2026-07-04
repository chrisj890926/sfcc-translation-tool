#!/usr/bin/env bash
#
# Convenience launcher for the SFCC XML Translator.
#
#   ./start.sh            # Claude provider on port 3100
#   PORT=4000 ./start.sh  # override the port
#
# Reads the Anthropic key from .anthropic-key so you don't have to export it
# every time. Ctrl-C to stop the server.

set -e

# Always run from the script's own directory (so you can call it from anywhere).
cd "$(dirname "$0")"

# --- Anthropic key ---
if [ -f .anthropic-key ]; then
  export ANTHROPIC_API_KEY="$(cat .anthropic-key)"
elif [ -z "$ANTHROPIC_API_KEY" ]; then
  echo "⚠️  No .anthropic-key file and ANTHROPIC_API_KEY is not set."
  echo "    The server will fall back to the free Google provider."
fi

# --- Provider / port (override by exporting before running) ---
export TRANSLATION_PROVIDER="${TRANSLATION_PROVIDER:-claude}"
export PORT="${PORT:-3100}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

echo "Provider : $TRANSLATION_PROVIDER"
echo "Port     : $PORT   ->  http://localhost:$PORT"
echo "Starting… (Ctrl-C to stop)"
echo ""

exec node src/server.js
