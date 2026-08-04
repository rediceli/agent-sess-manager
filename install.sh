#!/usr/bin/env bash
set -euo pipefail

REPO="rediceli/agent-sess-manager"
INSTALL_DIR="${AGENT_SESSION_HOME:-$HOME/.agent-session}"
BIN_DIR="/usr/local/bin"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { printf "${CYAN}[info]${NC}  %s\n" "$1"; }
ok()    { printf "${GREEN}[ok]${NC}    %s\n" "$1"; }
warn()  { printf "${YELLOW}[warn]${NC}  %s\n" "$1"; }
err()   { printf "${RED}[error]${NC} %s\n" "$1" >&2; }

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "'$1' is required but not installed. $2"
    exit 1
  fi
}

need_cmd curl  "Install curl: https://curl.se/"
need_cmd unzip "Install unzip: apt install unzip / brew install unzip"

if ! command -v bun >/dev/null 2>&1; then
  warn "'bun' is required but not installed."
  if [[ ! -r /dev/tty || ! -w /dev/tty ]]; then
    err "Cannot prompt for Bun installation: no interactive terminal is available. Install Bun manually: https://bun.sh"
    exit 1
  fi

  printf "Install bun automatically? [Y/n] " > /dev/tty
  if ! read -r REPLY < /dev/tty; then
    err "Could not read the Bun installation confirmation. Install Bun manually: https://bun.sh"
    exit 1
  fi
  REPLY="${REPLY:-Y}"
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    info "Installing bun..."
    export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$BUN_INSTALL/bin:$PATH"
    if command -v bun >/dev/null 2>&1; then
      ok "bun installed successfully ($(bun --version))"
    else
      err "bun installation failed. Please install manually: https://bun.sh"
      exit 1
    fi
  else
    err "Install bun manually: curl -fsSL https://bun.sh/install | bash"
    exit 1
  fi
fi

VERSION="${1:-latest}"
if [ "$VERSION" != "latest" ]; then
  TAG="$VERSION"
else
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null | grep '"tag_name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true)
  if [ -z "$TAG" ]; then
    TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/tags" 2>/dev/null | grep '"name"' | head -1 | sed -E 's/.*"([^"]+)".*/\1/' || true)
  fi
  if [ -z "$TAG" ]; then
    warn "Could not detect latest release, falling back to main branch"
    TAG="main"
  fi
fi

info "Installing agent-session ${TAG}..."

mkdir -p "$INSTALL_DIR"

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

if [ "$TAG" = "main" ]; then
  ARCHIVE_URL="https://github.com/${REPO}/archive/refs/heads/main.tar.gz"
else
  ARCHIVE_URL="https://github.com/${REPO}/archive/refs/tags/${TAG}.tar.gz"
fi

info "Downloading from ${ARCHIVE_URL}"
curl -fsSL "$ARCHIVE_URL" | tar xz -C "$TMPDIR" --strip-components=1

cd "$TMPDIR"

info "Installing dependencies..."
bun install --production

cp -r . "$INSTALL_DIR/"

mkdir -p "$INSTALL_DIR/bin"
cat > "$INSTALL_DIR/bin/agent-session" << WRAPPER
#!/usr/bin/env bash
SELF_PATH="\$(readlink -f "\$0" 2>/dev/null || echo "\$0")"
SELF_DIR="\$(cd "\$(dirname "\$SELF_PATH")/.." && pwd)"
exec bun run "\${AGENT_SESSION_HOME:-\$SELF_DIR}/src/cli.ts" "\$@"
WRAPPER
chmod +x "$INSTALL_DIR/bin/agent-session"

if [ -w "$BIN_DIR" ]; then
  ln -sf "$INSTALL_DIR/bin/agent-session" "$BIN_DIR/agent-session"
  ok "Linked agent-session -> $BIN_DIR/agent-session"
else
  USER_BIN_DIR="$HOME/.local/bin"
  mkdir -p "$USER_BIN_DIR"
  if ln -sf "$INSTALL_DIR/bin/agent-session" "$USER_BIN_DIR/agent-session"; then
    ok "Linked agent-session -> $USER_BIN_DIR/agent-session"
    case ":$PATH:" in
      *":$USER_BIN_DIR:"*) ;;
      *)
        warn "$USER_BIN_DIR is not on your PATH. Add this line to your shell rc:"
        echo ""
        echo "  export PATH=\"$USER_BIN_DIR:\$PATH\""
        echo ""
        ;;
    esac
  else
    warn "Could not write to $BIN_DIR or $USER_BIN_DIR. Add to PATH manually:"
    echo ""
    echo "  export PATH=\"$INSTALL_DIR/bin:\$PATH\""
    echo ""
    ok "Wrapper script available at $INSTALL_DIR/bin/agent-session"
  fi
fi

if command -v agent-session >/dev/null 2>&1; then
  ok "agent-session installed successfully!"
  agent-session --help 2>/dev/null | head -3 || true
else
  ok "Installation complete. Restart your shell or run:"
  echo ""
  echo "  source ~/.bashrc   # or ~/.zshrc"
  echo ""
  echo "Then: agent-session --help"
fi
