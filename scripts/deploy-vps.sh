#!/usr/bin/env bash
# Chạy trên VPS sau mỗi lần pull code mới.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/AutoeditFinal}"
BRANCH="${DEPLOY_BRANCH:-main}"
PM2_NAME="${PM2_NAME:-autoedit}"

cd "$APP_DIR"

echo "[deploy] $(date -Is) — branch $BRANCH"

git fetch origin "$BRANCH"
git reset --hard "origin/$BRANCH"

npm ci
npm run build

if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  NODE_ENV=production PORT="${PORT:-3001}" pm2 start npm --name "$PM2_NAME" -- start
fi

pm2 save

echo "[deploy] Done. Health:"
curl -sf "http://127.0.0.1:${PORT:-3001}/api/health" || true
echo ""
