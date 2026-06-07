#!/usr/bin/env bash
#
# tb installer — one command to get the agent browser running.
#
#   curl -fsSL https://raw.githubusercontent.com/hartmantexas/tb/main/install.sh | bash
#
# Or, from a checkout:  ./install.sh
#
# Idempotent: safe to re-run. Installs bun if missing, fetches the source,
# installs deps, links `tb` onto your PATH, downloads the Lightpanda engine,
# and builds the Blitz render engine (pixel-perfect screenshots) when Rust
# is available. Finishes with `tb doctor`.
#
set -euo pipefail

REPO_URL="${TB_REPO:-https://github.com/hartmantexas/tb.git}"
TB_SRC="${TB_SRC:-$HOME/.tb-src}"
BIN_DIR="${TB_BIN_DIR:-$HOME/.local/bin}"

log()  { printf "\033[1;36m▸\033[0m %s\n" "$1"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$1"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$1"; }
err()  { printf "\033[1;31m✗\033[0m %s\n" "$1" >&2; }

printf "\n\033[1mtb — agent browser installer\033[0m\n\n"

# 1. bun (JS runtime) ---------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  log "Installing bun (JavaScript runtime)…"
  curl -fsSL https://bun.sh/install | bash >/dev/null
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
command -v bun >/dev/null 2>&1 && ok "bun $(bun --version)" || { err "bun install failed"; exit 1; }

# 2. source: use current checkout, or clone -----------------------------------
if [ -f "./package.json" ] && grep -q '"name": *"tiny-browser"' package.json 2>/dev/null; then
  TB_SRC="$(pwd)"
  log "Using current checkout: $TB_SRC"
elif [ -d "$TB_SRC/.git" ]; then
  log "Updating existing checkout: $TB_SRC"
  git -C "$TB_SRC" pull --ff-only >/dev/null 2>&1 || warn "could not fast-forward; using existing"
else
  command -v git >/dev/null 2>&1 || { err "git is required to clone tb"; exit 1; }
  log "Cloning tb → $TB_SRC"
  git clone --depth 1 "$REPO_URL" "$TB_SRC" >/dev/null 2>&1
fi
cd "$TB_SRC"

# 3. dependencies -------------------------------------------------------------
log "Installing dependencies…"
bun install --silent >/dev/null 2>&1 || bun install
ok "dependencies installed"

# 4. put `tb` on PATH ---------------------------------------------------------
mkdir -p "$BIN_DIR"
chmod +x "$TB_SRC/bin/tb"
ln -sf "$TB_SRC/bin/tb" "$BIN_DIR/tb"
ok "tb linked → $BIN_DIR/tb"
TB="$BIN_DIR/tb"

# 5. Lightpanda engine (default — 64MB RAM) -----------------------------------
log "Installing Lightpanda engine…"
"$TB" install lightpanda || warn "Lightpanda download failed (network policy?) — Chromium fallback still works"

# 6. Blitz render engine (pixel-perfect screenshots, needs Rust) --------------
if command -v cargo >/dev/null 2>&1; then
  log "Building Blitz render engine — first build pulls ~260 crates, a few minutes…"
  "$TB" install render-engine || warn "Blitz build failed — screenshots fall back to approximation"
else
  warn "Rust/cargo not found — skipping Blitz."
  warn "  For pixel-perfect Lightpanda screenshots later:"
  warn "    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh && tb install render-engine"
fi

# 7. PATH hint ----------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    warn "Add $BIN_DIR to your PATH (then restart your shell):"
    printf '      \033[2mecho '\''export PATH="%s:$PATH"'\'' >> ~/.bashrc\033[0m\n' "$BIN_DIR"
    ;;
esac

# 8. verify -------------------------------------------------------------------
printf "\n"
"$TB" doctor || true

printf "\n\033[1;32mDone.\033[0m  Try:  \033[1mtb -w fhd open https://example.com && tb screenshot shot.png --open\033[0m\n\n"
