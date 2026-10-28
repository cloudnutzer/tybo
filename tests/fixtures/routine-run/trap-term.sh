#!/bin/sh
# Fängt SIGTERM ab, meldet es und endet mit 0
trap 'echo "SIGTERM erhalten" >&2; kill "$pid" 2>/dev/null; exit 0' TERM
sleep 30 &
pid=$!
echo "bereit"
wait "$pid"
