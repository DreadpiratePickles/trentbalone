#!/usr/bin/env bash
# Trent AI Cofounder — One-command local setup
# Usage: bash scripts/bootstrap.sh
set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()  { echo -e "${GREEN}[bootstrap]${NC} $*"; }
warn()  { echo -e "${YELLOW}[bootstrap]${NC} $*"; }
error() { echo -e "${RED}[bootstrap]${NC} $*" >&2; exit 1; }

info "Starting Trent local setup..."

# ── Prerequisites ──────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || error "Node.js not found. Install via https://nodejs.org or nvm."
command -v npm  >/dev/null 2>&1 || error "npm not found."
NODE_VER=$(node -e "process.exit(parseInt(process.versions.node) < 18 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "old")
[ "$NODE_VER" = "ok" ] || error "Node.js 18+ required. Found: $(node -v)"

# ── .env ──────────────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  cp .env.example .env
  warn ".env created from .env.example — fill in your secrets before starting."
else
  info ".env already exists — skipping copy."
fi

# ── Dependencies ───────────────────────────────────────────────────────────
info "Installing npm dependencies..."
npm install

# ── Prisma ─────────────────────────────────────────────────────────────────
info "Generating Prisma client..."
npx prisma generate

info "Pushing database schema (SQLite dev)..."
npx prisma db push --skip-generate

# ── Seed ───────────────────────────────────────────────────────────────────
if [ "${SKIP_SEED:-}" != "1" ]; then
  info "Seeding database with demo data..."
  npx tsx scripts/seed-db.ts || warn "Seed failed — run manually: npx tsx scripts/seed-db.ts"
fi

# ── Done ───────────────────────────────────────────────────────────────────
echo ""
info "✓ Setup complete! Start the dev server with:"
echo ""
echo "  npm run dev"
echo ""
info "Optional: start background services with Docker:"
echo "  docker compose -f docker-compose.dev.yml up -d"
echo ""
