#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  models)
    printf '%s\n' 'gemini-3.6-flash-medium' 'gemini-3.6-pro-high'
    ;;
  changelog)
    printf '%s\n' 'agy version 0.1.0-docker-qa'
    ;;
  *)
    printf '%s\n' 'Antigravity Docker QA interactive shell'
    ;;
esac
