#!/bin/bash
set -e

cd /home/leccato
SCREEN="QubiqoHost"

PID=$(ps -eo pid=,cmd= | awk '$0 ~ /^[[:space:]]*[0-9]+[[:space:]]+\/usr\/bin\/node \/home\/leccato\/server\.js([[:space:]]|$)/ {print $1; exit}')

if [ -n "$PID" ]; then
  echo "[QubiqoHost] Arresto del solo pannello PID $PID..."
  kill "$PID"
  for i in {1..15}; do
    if ! kill -0 "$PID" 2>/dev/null; then break; fi
    sleep 1
  done
  if kill -0 "$PID" 2>/dev/null; then
    kill -9 "$PID"
  fi
fi

if screen -list | grep -q "\.${SCREEN}[[:space:]]"; then
  screen -S "$SCREEN" -X stuff $'cd /home/leccato && exec node server.js\n'
else
  screen -dmS "$SCREEN" bash -lc 'cd /home/leccato && exec node server.js'
fi

sleep 2

NEW_PID=$(ps -eo pid=,cmd= | awk '$0 ~ /^[[:space:]]*[0-9]+[[:space:]]+\/usr\/bin\/node \/home\/leccato\/server\.js([[:space:]]|$)/ {print $1; exit}')

if [ -n "$NEW_PID" ]; then
  echo "[QubiqoHost] ✓ Pannello riavviato. PID $NEW_PID"
  echo "[QubiqoHost] ✓ I bot non sono stati arrestati."
else
  echo "[QubiqoHost] ✗ Il pannello non risulta avviato."
  exit 1
fi
