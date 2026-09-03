#!/usr/bin/env bash

openclaw_frozen_target_omissions_authorized() {
  case "${OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS:-0}" in
    0 | "")
      return 1
      ;;
    1) ;;
    *)
      echo "invalid OPENCLAW_ALLOW_FROZEN_TARGET_SCENARIO_OMISSIONS: expected 0 or 1" >&2
      return 2
      ;;
  esac

  if [[ ! "${OPENCLAW_SELECTED_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "OPENCLAW_SELECTED_SHA must be a full lowercase commit SHA" >&2
    return 2
  fi
  if [[ ! "${OPENCLAW_TOOLING_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "OPENCLAW_TOOLING_SHA must be a full lowercase commit SHA" >&2
    return 2
  fi
  if [[ "$OPENCLAW_SELECTED_SHA" == "$OPENCLAW_TOOLING_SHA" ]]; then
    echo "frozen-target omissions require distinct selected and tooling SHAs" >&2
    return 2
  fi
}

openclaw_frozen_target_session_repair_mode() {
  local source_root="${1:?missing selected source root}"

  if ! git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/state/openclaw-agent-db-session-migrations.ts" 2>/dev/null &&
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/commands/doctor-session-transcripts.ts" 2>/dev/null |
      grep -Fq '.pre-doctor-branch-repair-'; then
    printf '%s\n' jsonl
  else
    printf '%s\n' sqlite
  fi
}

openclaw_resolve_frozen_upgrade_survivor_capabilities() {
  local source_root="${1:?missing selected source root}" authorization_status=0

  export OPENCLAW_UPGRADE_SURVIVOR_EXEC_APPROVALS_MODE="required" \
    OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_REQUEST_DIALECT="current" \
    OPENCLAW_UPGRADE_SURVIVOR_SESSION_REPAIR_MODE="sqlite"

  openclaw_frozen_target_omissions_authorized || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  if [ "$(git -C "$source_root" rev-parse HEAD 2>/dev/null)" != "$OPENCLAW_SELECTED_SHA" ]; then
    echo "selected source checkout does not match OPENCLAW_SELECTED_SHA" >&2
    return 2
  fi

  if ! git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/infra/exec-approvals-sqlite.ts" 2>/dev/null &&
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/infra/exec-approvals.ts" 2>/dev/null |
      grep -Fq 'const EXEC_APPROVALS_FILE = "exec-approvals.json";'; then
    export OPENCLAW_UPGRADE_SURVIVOR_EXEC_APPROVALS_MODE="omitted"
  fi

  if ! git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/infra/clawhub-install-trust.ts" 2>/dev/null &&
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/plugins/clawhub.ts" 2>/dev/null |
      grep -Fq 'from "../infra/clawhub.js"'; then
    export OPENCLAW_UPGRADE_SURVIVOR_CLAWHUB_REQUEST_DIALECT="legacy"
  fi

  export OPENCLAW_UPGRADE_SURVIVOR_SESSION_REPAIR_MODE
  OPENCLAW_UPGRADE_SURVIVOR_SESSION_REPAIR_MODE="$(openclaw_frozen_target_session_repair_mode "$source_root")"
}

openclaw_resolve_frozen_core_harness_capabilities() {
  local source_root="${1:?missing selected source root}" authorization_status=0

  export OPENCLAW_FROZEN_TARGET_ONBOARD_CASES="" \
    OPENCLAW_FROZEN_TARGET_ONBOARD_SESSION_MEMORY_HOOK_MODE="required" \
    OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE="current" \
    OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE="current" \
    OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE="current" \
    OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE="sqlite"

  openclaw_frozen_target_omissions_authorized || authorization_status=$?
  [ "$authorization_status" -eq 1 ] && return 0
  [ "$authorization_status" -eq 0 ] || return "$authorization_status"

  if [ "$(git -C "$source_root" rev-parse HEAD 2>/dev/null)" != "$OPENCLAW_SELECTED_SHA" ]; then
    echo "selected source checkout does not match OPENCLAW_SELECTED_SHA" >&2
    return 2
  fi

  # The pre-consent onboarding flow does not accept the wizard record or the
  # newer guided case. Run its own established non-interactive coverage.
  if ! git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/config/zod-schema.ts" 2>/dev/null |
    grep -Fq 'securityAcknowledgedAt:' &&
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/config/zod-schema.ts" 2>/dev/null |
      grep -Fq 'lastRunAt:'; then
    export OPENCLAW_FROZEN_TARGET_ONBOARD_CASES="local-basic,remote-non-interactive,reset,channels,skills"
  fi

  # Before default-hook onboarding, quickstart offered only the hooks it found
  # in the workspace. A successful old quickstart therefore cannot promise a
  # session-memory entry when that workspace shipped no hook definition.
  if git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/commands/onboard-hooks.ts" 2>/dev/null &&
    git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/commands/onboard-hooks.ts" 2>/dev/null |
      grep -Fq 'setupInternalHooks' &&
    ! git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/commands/onboard-hooks.ts" 2>/dev/null |
      grep -Fq 'enableDefaultOnboardingInternalHooks'; then
    export OPENCLAW_FROZEN_TARGET_ONBOARD_SESSION_MEMORY_HOOK_MODE="interactive"
  fi

  if git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/agents/memory-search.ts" 2>/dev/null |
    grep -Fq 'cfg.agents?.defaults?.memorySearch'; then
    export OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE="agent"
  fi

  # The selected release exposes ALL_TOOLS to code mode but predates the
  # catalog global. Its fixture program must use that shipped global or exec
  # throws before it can return the MCP result being proved.
  if git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/agents/code-mode-namespaces.ts" 2>/dev/null |
    grep -Fq '"ALL_TOOLS"' &&
    ! git -C "$source_root" show "$OPENCLAW_SELECTED_SHA:src/agents/code-mode-namespaces.ts" 2>/dev/null |
      grep -Fq '"catalog"'; then
    export OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE="legacy"
  fi

  export OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE
  OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE="$(openclaw_frozen_target_session_repair_mode "$source_root")"

  # The manager API and MCP App assertions were added after the selected
  # release. Run its still-packaged bundle-MCP contract instead of importing a
  # new dist entry the release cannot contain.
  if ! git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/agents/agent-bundle-mcp-manager-api.ts" 2>/dev/null &&
    git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:src/agents/agent-bundle-mcp-runtime.ts" 2>/dev/null &&
    git -C "$source_root" cat-file -e "$OPENCLAW_SELECTED_SHA:scripts/e2e/agent-bundle-mcp-tools-docker-client.ts" 2>/dev/null; then
    export OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE="legacy"
  fi
}
