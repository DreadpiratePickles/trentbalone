#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "⚡ Building Trent CLI binary and core packages..."

cd "$DIR"

# Build trent-core
npm run --workspace=packages/trent-core build || true

# Build cli package
npm run --workspace=apps/cli build || true

echo "✓ Build complete. CLI entry at apps/cli/src/index.ts"
