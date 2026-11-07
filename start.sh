#!/bin/zsh
# Starts ViaProxy (bots speak 26.1 -> proxy -> Feather server), then the bots.
# When you run it yourself it asks for the server IP; Ctrl+C stops everything it started.
cd "$(dirname "$0")"
JAVA=${JAVA:-/opt/homebrew/opt/openjdk/bin/java}

# The server to join. There is no built-in default and no remembered last address — you type
# it fresh every run. Only use a server you own or are allowed on.
if [ -t 0 ] && [ -z "$BOTS_CONFIG" ]; then
  SERVER=""
  while :; do
    echo -n "Server address: "
    read SERVER
    [ -n "$SERVER" ] && break
    echo "Type a server address, e.g. play.example.com"
  done
else
  SERVER=$(cat server.txt 2>/dev/null)   # non-interactive (preset) launches only
fi
if [ -z "$SERVER" ]; then echo "No server address given."; exit 1; fi
echo "$SERVER" > server.txt
case "$SERVER" in (*:*) TARGET=$SERVER;; (*) TARGET=$SERVER:25565;; esac

# (Re)start ViaProxy if it's down, or pointed at a different server than we want now.
STARTED_PROXY=0
if ! nc -z 127.0.0.1 25568 2>/dev/null || [ "$(cat proxy_target.txt 2>/dev/null)" != "$TARGET" ]; then
  pkill -f "ViaProxy.jar cli" 2>/dev/null
  until ! nc -z 127.0.0.1 25568 2>/dev/null; do sleep 1; done
  echo "Starting ViaProxy -> $TARGET ..."
  (cd viaproxy && exec "$JAVA" -jar ViaProxy.jar cli --bind-address 127.0.0.1:25568 \
    --target-address "$TARGET" --auth-method NONE > proxy.log 2>&1) &
  PROXY_PID=$!
  echo "$TARGET" > proxy_target.txt
  STARTED_PROXY=1
  trap 'kill $PROXY_PID 2>/dev/null' EXIT INT TERM
  until nc -z 127.0.0.1 25568 2>/dev/null; do sleep 1; done
  echo "ViaProxy ready."
fi

node bots.js "$@"
