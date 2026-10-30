#!/usr/bin/env bash
# Fresh machine -> running ultimatehuman, from a checkout of this repo:
#   Node 22+ (via nvm when missing) -> pnpm (corepack, else npm) -> install -> build -> init.
#
#   bash scripts/bootstrap.sh              # ends in the interactive `ultimatehuman init`
#   bash scripts/bootstrap.sh --no-init    # stop after the build
#   bash scripts/bootstrap.sh -- --non-interactive   # anything after -- goes to init
#
# Idempotent: every step checks first and skips what is already there. It never uses sudo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NVM_VERSION="v0.40.1"
RUN_INIT=1
INIT_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-init) RUN_INIT=0 ;;
    --) shift; INIT_ARGS=("$@"); break ;;
    *) echo "unknown option: $1 (try --no-init, or pass init flags after --)" >&2; exit 2 ;;
  esac
  shift
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# 1. Node 22+
if command -v node >/dev/null && [ "$(node_major)" -ge 22 ]; then
  say "node $(node -v) found"
else
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    say "installing nvm $NVM_VERSION"
    curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | PROFILE=/dev/null bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  say "installing node 22 with nvm"
  nvm install 22 >/dev/null
  nvm use 22 >/dev/null
  say "node $(node -v) ready (add 'source $NVM_DIR/nvm.sh' to your shell profile to keep it)"
fi

# 2. pnpm, at the version package.json pins
PNPM_VERSION="$(node -p 'require(process.argv[1]).packageManager.split("@")[1]' "$ROOT/package.json")"
if command -v pnpm >/dev/null && [ "$(pnpm -v)" = "$PNPM_VERSION" ]; then
  say "pnpm $PNPM_VERSION found"
elif command -v corepack >/dev/null && corepack enable 2>/dev/null; then
  corepack prepare "pnpm@$PNPM_VERSION" --activate >/dev/null
  say "pnpm $(pnpm -v) via corepack"
else
  # Node 25+ ships without corepack; a user-level npm prefix avoids sudo.
  if ! npm i -g "pnpm@$PNPM_VERSION" >/dev/null 2>&1; then
    npm config set prefix "$HOME/.npm-global"
    npm i -g "pnpm@$PNPM_VERSION" >/dev/null
  fi
  export PATH="$(npm config get prefix)/bin:$PATH"
  say "pnpm $(pnpm -v) via npm (add $(npm config get prefix)/bin to your PATH to keep it)"
fi

# 3. install + build
cd "$ROOT"
say "installing dependencies"
pnpm install --frozen-lockfile
say "building dashboard + CLI"
pnpm build
CLI="$ROOT/packages/cli/dist/cli.mjs"
node "$CLI" help >/dev/null
say "built: node $CLI"

# 4. init
if [ "$RUN_INIT" = 1 ]; then
  say "starting ultimatehuman init"
  exec node "$CLI" init "${INIT_ARGS[@]+"${INIT_ARGS[@]}"}"
fi
say "done. Next: node $CLI init"
