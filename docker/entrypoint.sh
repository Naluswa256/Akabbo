#!/bin/sh
# Dispatch to the correct process based on APP_ROLE (default: api).
# One image, two Cloud Run services differing only by this env var.
set -e

APP_ROLE="${APP_ROLE:-api}"

case "$APP_ROLE" in
  api)
    echo "Starting Akabbo API process"
    exec node dist/apps/api/apps/api/src/main.js
    ;;
  worker)
    echo "Starting Akabbo worker process"
    exec node dist/apps/worker/apps/worker/src/main.js
    ;;
  *)
    echo "Unknown APP_ROLE='$APP_ROLE' (expected 'api' or 'worker')" >&2
    exit 1
    ;;
esac
