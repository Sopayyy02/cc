#!/usr/bin/env bash
# Safe reset: only synthetic LT0001+ accounts; real exam data is never cleared.
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/reset-loadtest.js
