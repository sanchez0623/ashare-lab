#!/usr/bin/env bash
set -e
cd -- "$(dirname -- "$0")"
exec node scripts/local-watch.mjs "$@"
