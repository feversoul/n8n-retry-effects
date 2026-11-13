#!/bin/sh
# test/stack.sh up|down|logs [queue]   the test stack by hand
cd "$(dirname "$0")/.."
action=$1
files="-f docker-compose.yml -f test/docker-compose.yml"
[ "${2:-}" = queue ] && files="$files -f test/docker-compose.queue.yml"
case "$action" in
  up) docker compose --env-file test/test.env $files -p retryfx-test up -d ;;
  down) docker compose --env-file test/test.env $files -p retryfx-test down -v ;;
  logs) docker compose --env-file test/test.env $files -p retryfx-test logs --tail "${TAIL:-40}" n8n ;;
esac
