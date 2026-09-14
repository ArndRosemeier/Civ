#!/usr/bin/env bash
# CivTS - incremental FTP sync to futuremagic.de
#
# Adapted from Campaigner's deploy-sync.sh (the Linux counterpart of its deploy-sync.ps1).
# What changed, and why, is listed in the header comment of `deploy-ftp.py` and below.
#
# Builds `@civts/web` with the subdirectory Vite base, uploads only new/changed files (by size),
# and removes remote files that are no longer in the build.
#
# Usage (from the repo root):
#   ./deploy-sync.sh
#   pnpm run deploy:sync
#
# Password: $FTP_PASSWORD, or ~/.config/civ/ftp.env, or ./.ftp.env.local (each mode 600, never
# committed). See the error message at the bottom of the resolution block if none is found.
#
# Environment knobs:
#   CIV_BASE=/Civ/   override the web base (default below; must match REMOTE_PATH's last segment)
#   SKIP_VERIFY=1    skip the `pnpm verify` gate before building (see the note where it runs)
#
# **This is the local twin of `.github/workflows/deploy.yml`, and they must agree.** That workflow
# deploys the same build to the same host on every push to `master`; this script is for deploying from
# this machine by hand. Both read `CIV_BASE`, both copy `packages/web/public/.htaccess` into the build
# with the same `RewriteBase`, and both upload to `/webseiten/Civ/`. If you change one, change the
# other — two deploy paths that disagree is a slower version of having none.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
FTP_SERVER="ftp.futuremagic.de"
FTP_USER="12529-Pyrion"
REMOTE_PATH="/webseiten/Civ/"
BASE_PATH="${CIV_BASE:-/Civ/}"
PUBLIC_URL="https://futuremagic.de/Civ/"
NODE_BIN="/home/box/.local/node-v24.20.0-linux-x64/bin"
export PATH="${NODE_BIN}:${PATH}"
HOME_ENV_FILE="${HOME}/.config/civ/ftp.env"
REPO_ENV_FILE="${SCRIPT_DIR}/.ftp.env.local"

# The app is a package inside the pnpm workspace, so the build and the upload both live one level
# down. `DIST_DIR` is what the Python differ is pointed at, and it must be the directory that
# contains index.html — not the repo root, and not the workspace root.
DIST_DIR="${SCRIPT_DIR}/packages/web/dist"

# xtrace would leak FTP_PASSWORD when it is passed to python.
if [[ $- == *x* ]]; then
  echo "Error: do not run this script with bash -x (it can leak secrets)." >&2
  exit 1
fi

if [[ -t 1 ]]; then
  C_CYAN=$'\033[36m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'
  C_RESET=$'\033[0m'
else
  C_CYAN=""
  C_GREEN=""
  C_YELLOW=""
  C_RED=""
  C_RESET=""
fi

# Parse KEY=VALUE lines from an env file without sourcing (no eval/source).
# Skips comments and blank lines. Only FTP_PASSWORD is consumed.
# Surrounding single or double quotes on the value are stripped.
# CRLF is tolerated. Never prints the value.
load_ftp_password_from_file() {
  local file="$1"
  local line key value
  [[ -f "$file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    # skip blank
    [[ -z "${line//[[:space:]]/}" ]] && continue
    # skip comments (optional leading whitespace)
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    # optional "export " prefix, then KEY=VALUE
    if [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      value="${BASH_REMATCH[3]}"
      if [[ "$key" == "FTP_PASSWORD" ]]; then
        if [[ "$value" =~ ^\"(.*)\"$ ]]; then
          value="${BASH_REMATCH[1]}"
        elif [[ "$value" =~ ^\'(.*)\'$ ]]; then
          value="${BASH_REMATCH[1]}"
        fi
        if [[ -n "$value" ]]; then
          FTP_PASSWORD="$value"
          return 0
        fi
      fi
    fi
  done < "$file"
}

warn_mode_600() {
  local file="$1"
  local mode
  mode="$(stat -c '%a' "$file" 2>/dev/null || true)"
  if [[ -n "$mode" && "$mode" != "600" ]]; then
    echo "${C_YELLOW}Warning: ${file} is mode ${mode}; chmod 600 is preferred.${C_RESET}" >&2
  fi
}

if [[ -n "${FTP_PASSWORD:-}" ]]; then
  echo "${C_GREEN}Using stored password${C_RESET}"
elif [[ -f "$HOME_ENV_FILE" ]]; then
  warn_mode_600 "$HOME_ENV_FILE"
  load_ftp_password_from_file "$HOME_ENV_FILE"
  if [[ -n "${FTP_PASSWORD:-}" ]]; then
    echo "${C_GREEN}Using stored password${C_RESET}"
  fi
fi
if [[ -z "${FTP_PASSWORD:-}" && -f "$REPO_ENV_FILE" ]]; then
  warn_mode_600 "$REPO_ENV_FILE"
  load_ftp_password_from_file "$REPO_ENV_FILE"
  if [[ -n "${FTP_PASSWORD:-}" ]]; then
    echo "${C_GREEN}Using stored password${C_RESET}"
  fi
fi
if [[ -z "${FTP_PASSWORD:-}" ]]; then
  echo "Error: FTP_PASSWORD is not set." >&2
  echo "Create ${HOME_ENV_FILE} (chmod 600) with a KEY=VALUE line:" >&2
  echo "  FTP_PASSWORD=..." >&2
  echo "Do not commit that file. You can also export FTP_PASSWORD," >&2
  echo "or use ${REPO_ENV_FILE} (gitignored)." >&2
  exit 1
fi
# Do not export during build; python child receives it via prefix assignment only.
_CIVTS_FTP_PASSWORD="$FTP_PASSWORD"
unset FTP_PASSWORD
trap 'unset FTP_PASSWORD _CIVTS_FTP_PASSWORD' EXIT

echo "${C_CYAN}Starting DIFF SYNC CivTS deployment...${C_RESET}"
echo "${C_YELLOW}Remote is not wiped - only new/changed files upload; stale remote files are removed.${C_RESET}"
echo "${C_CYAN}Vite base: ${BASE_PATH}${C_RESET}"
echo "${C_CYAN}Public URL: ${PUBLIC_URL}${C_RESET}"

# **The gate runs before the upload, not after.** This app has a mutation-checked test suite and a
# typed build; deploying without it means the first thing to notice a broken engine is a player. It
# costs about forty seconds. `SKIP_VERIFY=1` exists for re-deploying a build you have already gated
# this session — it is not for skipping a failure, so the gate's own exit code stops the script.
if [[ "${SKIP_VERIFY:-}" == "1" ]]; then
  echo "${C_YELLOW}Skipping pnpm verify (SKIP_VERIFY=1)${C_RESET}"
else
  echo "${C_YELLOW}Running the gate: pnpm verify${C_RESET}"
  pnpm verify
  echo "${C_GREEN}Gate passed.${C_RESET}"
fi

echo "${C_YELLOW}Cleaning build folder...${C_RESET}"
rm -rf "$DIST_DIR"

echo "${C_YELLOW}Building @civts/web with base ${BASE_PATH}...${C_RESET}"
CIV_BASE="$BASE_PATH" pnpm --filter @civts/web build

# `packages/web/public/.htaccess` is copied into the build with its `RewriteBase` set to the base
# path, exactly as `.github/workflows/deploy.yml` does it. Two details are load-bearing:
#
# - **Vite does not copy a dotfile from `public/`**, so the file has to be placed by hand or the
#   upload ships without it and the deployed app answers a deep link with a 404 that looks like a
#   broken build.
# - **The `RewriteBase` has to match the base the app was built with.** It is rewritten here rather
#   than hardcoded in `public/`, so changing `BASE_PATH` cannot leave the two disagreeing.
#
# The trap BOM is stripped because a byte-order mark before `RewriteEngine` makes Apache treat the
# first directive as garbage.
HTACCESS_SRC="packages/web/public/.htaccess"
if [[ ! -f "$HTACCESS_SRC" ]]; then
  echo "${C_RED}Error: ${HTACCESS_SRC} is missing (the SPA rewrite rules)${C_RESET}" >&2
  exit 1
fi
echo "${C_YELLOW}Copying .htaccess with RewriteBase ${BASE_PATH}...${C_RESET}"
sed '1s/^\xEF\xBB\xBF//' "$HTACCESS_SRC" \
  | sed -E 's|^([[:space:]]*RewriteBase[[:space:]]+)\S+|\1'"${BASE_PATH}"'|' \
  > packages/web/dist/.htaccess

if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "${C_RED}Error: build produced no index.html in ${DIST_DIR}${C_RESET}" >&2
  exit 1
fi

# A base path that does not match where the files land is the failure this whole script exists to
# avoid, and it is invisible until someone opens the page: the HTML loads, every asset 404s, and the
# screen stays blank. Check the built HTML actually references the base it was built with.
if ! grep -q "src=\"${BASE_PATH}assets/\|href=\"${BASE_PATH}assets/" "$DIST_DIR/index.html"; then
  echo "${C_RED}Error: dist/index.html does not reference ${BASE_PATH}assets/ — the Vite base did not${C_RESET}" >&2
  echo "${C_RED}reach the build, so the app would deploy with the wrong asset URLs.${C_RESET}" >&2
  exit 1
fi

echo "${C_GREEN}Build successful!${C_RESET}"

set +e
FTP_PASSWORD="$_CIVTS_FTP_PASSWORD" python3 "$SCRIPT_DIR/deploy-ftp.py" \
  --server "$FTP_SERVER" \
  --user "$FTP_USER" \
  --remote "$REMOTE_PATH" \
  --dist "$DIST_DIR"
status=$?
set -e
unset FTP_PASSWORD _CIVTS_FTP_PASSWORD

if [[ "$status" -ne 0 ]]; then
  exit "$status"
fi

echo "${C_CYAN}App should now work at: ${PUBLIC_URL}${C_RESET}"

# **Registration: the step Campaigner's Linux script skips.** That script prints
# "[SKIP] Windows Register-FuturemagicApp.ps1 helper", so on Linux this app would upload and stay
# invisible on the landing page, which reads `/apps.json` at the web root. `register-app.py` is that
# helper for this platform: it upserts our one entry and leaves the other apps' entries alone.
#
# It runs *after* a successful upload, because registering an app whose files are not there would put
# a broken tile on the landing page. `SKIP_REGISTER=1` bypasses it for a re-upload that has not
# changed the app's identity.
if [[ "${SKIP_REGISTER:-}" == "1" ]]; then
  echo "${C_YELLOW}Skipping registration (SKIP_REGISTER=1)${C_RESET}"
else
  echo "${C_YELLOW}Registering in the site's app registry...${C_RESET}"
  FTP_PASSWORD="$_CIVTS_FTP_PASSWORD" python3 "$SCRIPT_DIR/register-app.py" \
    --server "$FTP_SERVER" \
    --user "$FTP_USER" \
    --slug "Civ" \
    --title "CivTS" \
    --path "$BASE_PATH" \
    --manifesto "$SCRIPT_DIR/packages/web/public/futuremagic.json" \
    --backup-dir "$SCRIPT_DIR" || \
    echo "${C_YELLOW}Registration failed; the app is uploaded but may not be listed.${C_RESET}" >&2
fi
unset FTP_PASSWORD _CIVTS_FTP_PASSWORD

exit 0
