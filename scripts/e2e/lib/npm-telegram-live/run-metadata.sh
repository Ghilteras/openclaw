#!/usr/bin/env bash

npm_telegram_live_normalize_failure_phase() {
  case "$1" in
    runtime-probe | hotpath-plugin-help | hotpath-plugin-install | hotpath-onboard | hotpath-channel-add | hotpath-doctor-fix | hotpath-doctor-check | telegram-live-runner)
      printf '%s\n' "$1"
      ;;
    *)
      printf '%s\n' unclassified
      ;;
  esac
}

npm_telegram_live_reset_run_metadata() {
  local output_dir="$1"
  mkdir -p "$output_dir"
  rm -f "$output_dir/failure-phase.txt"
}

npm_telegram_live_write_run_metadata() {
  local output_dir="$1"
  local exit_code="$2"
  local failure_phase=none
  local candidate

  if [ "$exit_code" -ne 0 ]; then
    failure_phase=unclassified
    if [ -f "$output_dir/failure-phase.txt" ]; then
      read -r candidate < "$output_dir/failure-phase.txt" || true
      failure_phase="$(npm_telegram_live_normalize_failure_phase "$candidate")"
    fi
  fi

  printf 'schema=1\nexit_code=%s\nlive_output=job_log\nfailure_phase=%s\n' \
    "$exit_code" "$failure_phase" > "$output_dir/run-metadata.txt"
}
