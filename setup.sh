#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required. $2"
}

prompt_secret() {
  local prompt="$1"
  local value
  printf '%s: ' "$prompt" >&2
  IFS= read -r -s value
  printf '\n' >&2
  [[ -n "$value" ]] || fail "$prompt cannot be empty"
  printf '%s' "$value"
}

set_secret() {
  local name="$1"
  local value="$2"
  printf '%s' "$value" | gh secret set "$name" --repo "$REPOSITORY"
}

require_command git 'Install Git from https://git-scm.com/downloads.'
require_command node 'Install Node.js 20 or newer from https://nodejs.org/.'
require_command npm 'Install Node.js 20 or newer from https://nodejs.org/.'
require_command gh 'Install GitHub CLI from https://cli.github.com/.'

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
[[ "$NODE_MAJOR" -ge 20 ]] || fail "Node.js 20 or newer is required; found $(node --version)"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || fail 'Run this installer inside your Knicks Ticket Monitor repository.'
gh auth status >/dev/null 2>&1 \
  || fail "GitHub CLI is not authenticated. Run 'gh auth login' first."

REPOSITORY="$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null)" \
  || fail 'Could not identify the GitHub repository from the current Git remote.'
[[ -n "$REPOSITORY" ]] || fail 'The current Git repository has no GitHub remote.'

printf '\nConfiguring Knicks Ticket Monitor for %s\n' "$REPOSITORY"
printf 'Your input stays hidden and is sent directly to GitHub Actions secrets.\n\n'

TICKETMASTER_API_KEY="$(prompt_secret 'Ticketmaster consumer key')"
TELEGRAM_BOT_TOKEN="$(prompt_secret 'Telegram bot token')"
TELEGRAM_CHAT_ID="$(prompt_secret 'Telegram numeric chat ID')"

[[ "$TELEGRAM_BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] \
  || fail 'The Telegram bot token format is invalid.'
[[ "$TELEGRAM_CHAT_ID" =~ ^-?[0-9]+$ ]] \
  || fail 'The Telegram chat ID must contain only digits, optionally beginning with a minus sign.'

trap 'unset TICKETMASTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID' EXIT

printf '\nSaving encrypted GitHub Actions secrets...\n'
set_secret TICKETMASTER_API_KEY "$TICKETMASTER_API_KEY"
set_secret TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
set_secret TELEGRAM_CHAT_ID "$TELEGRAM_CHAT_ID"

unset TICKETMASTER_API_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID

printf '\nRunning automated tests...\n'
npm test

printf '\nStarting the Telegram verification workflow...\n'
gh workflow run check-knicks.yml --repo "$REPOSITORY"

printf '\nSetup complete. Follow the workflow at:\n'
printf 'https://github.com/%s/actions/workflows/check-knicks.yml\n' "$REPOSITORY"
printf 'A successful run sends a confirmation message to your Telegram bot.\n'
