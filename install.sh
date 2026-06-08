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
need_cmd bun   "Install bun: curl -fsSL https://bun.sh/install | bash"

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
