#!/usr/bin/env bash
set -e

# Trent Fleet One-Line Installer
# Installs Trent to ~/.trent without root/sudo permissions

echo -e "\033[38;2;139;92;246m  ████████╗██████╗ ███████╗███╗   ██╗████████╗\033[0m"
echo -e "\033[38;2;139;92;246m  ╚══██╔══╝██╔══██╗██╔════╝████╗  ██║╚══██╔══╝\033[0m"
echo -e "\033[38;2;139;92;246m     ██║   ██████╔╝█████╗  ██╔██╗ ██║   ██║   \033[0m"
echo -e "\033[38;2;139;92;246m     ██║   ██╔══██╗██╔══╝  ██║╚██╗██║   ██║   \033[0m"
echo -e "\033[38;2;139;92;246m     ██║   ██║  ██║███████╗██║ ╚████║   ██║   \033[0m"
echo -e "\033[38;2;139;92;246m     ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝   ╚═╝   \033[0m"
echo -e "\033[38;2;6;182;212m       ⚡ F L E E T · A I   C O F O U N D E R ⚡\033[0m"
echo ""
echo "⚡ Installing Trent Fleet — AI Cofounder Platform..."

TRENT_HOME="${HOME}/.trent"
TRENT_BIN_DIR="${TRENT_HOME}/bin"

mkdir -p "${TRENT_BIN_DIR}"
mkdir -p "${TRENT_HOME}/sessions"
mkdir -p "${TRENT_HOME}/skills"
mkdir -p "${TRENT_HOME}/agents"
mkdir -p "${TRENT_HOME}/logs"

# Create launcher wrapper
cat << 'EOF' > "${TRENT_BIN_DIR}/trent"
#!/usr/bin/env bash
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${DIR}/../.." && pwd)"

if command -v node >/dev/null 2>&1; then
  NODE_BIN="node"
else
  echo "Error: Node.js is required to run Trent. Please install Node 20+."
  exit 1
fi

exec npx tsx "${ROOT_DIR}/apps/cli/src/index.ts" "$@"
EOF

chmod +x "${TRENT_BIN_DIR}/trent"

# Update PATH if needed
SHELL_RC=""
if [ -n "$ZSH_VERSION" ] || [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
fi

if [ -n "$SHELL_RC" ]; then
  if ! grep -q 'export PATH="$HOME/.trent/bin:$PATH"' "$SHELL_RC" 2>/dev/null; then
    echo '' >> "$SHELL_RC"
    echo '# Trent Fleet' >> "$SHELL_RC"
    echo 'export PATH="$HOME/.trent/bin:$PATH"' >> "$SHELL_RC"
    echo "✓ Added ~/.trent/bin to ${SHELL_RC}"
  fi
fi

echo "✅ Trent Fleet installed successfully to ${TRENT_HOME}!"
echo ""
echo "To get started, open a new terminal or run:"
echo "  export PATH=\"\$HOME/.trent/bin:\$PATH\""
echo "  trent setup"
echo "  trent"
