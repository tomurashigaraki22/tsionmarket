#!/usr/bin/env bash
#
# One-click deployment for api.tsionmarket.com
#
#   ./deploy.sh              build, migrate, start, verify
#   ./deploy.sh --logs       follow logs afterwards
#
# First run creates deploy/.env with freshly generated secrets and then stops,
# so you can fill in the handful of values only you know (email provider, RPC
# URLs, frontend origin). Re-run to deploy.
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE_FILE="deploy/docker-compose.prod.yml"
ENV_FILE="deploy/.env"
DOMAIN_DEFAULT="api.tsionmarket.com"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

secret() {
  # 48 bytes of base64url — comfortably above the 16-char minimum the
  # production config enforces on database passwords.
  openssl rand -base64 48 | tr -d '\n=+/' | cut -c1-48
}

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require docker
require openssl
docker compose version >/dev/null 2>&1 || {
  echo "Docker Compose v2 is required (docker compose ...)." >&2
  exit 1
}

# ---------------------------------------------------------------- first run --
if [[ ! -f "$ENV_FILE" ]]; then
  echo "No $ENV_FILE yet — generating one with fresh secrets."
  umask 077
  cat > "$ENV_FILE" <<EOF
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ). Keep this file secret and off git.

API_DOMAIN=$DOMAIN_DEFAULT
# Let's Encrypt sends expiry warnings here.
ACME_EMAIL=CHANGE_ME@tsionmarket.com

# Port the API listens on, published to 127.0.0.1 only.
API_LOCAL_PORT=3456

# Browser origins allowed to call this API (comma separated, no trailing slash).
CORS_ALLOWED_ORIGINS=https://tsionmarket.com,https://www.tsionmarket.com

# --- generated secrets, no need to edit ---
MYSQL_ROOT_PASSWORD=$(secret)
MYSQL_DATABASE=tsionmarket
MYSQL_USER=tsionmarket_app
MYSQL_PASSWORD=$(secret)
MYSQL_MIGRATION_USER=tsionmarket_migrator
MYSQL_MIGRATION_PASSWORD=$(secret)

AUTH_ACCESS_TOKEN_SECRET=$(secret)
AUTH_REFRESH_TOKEN_PEPPER=$(secret)
AUTH_PASSWORD_PEPPER=$(secret)
AUTH_CHALLENGE_PEPPER=$(secret)
METRICS_BEARER_TOKEN=$(secret)

# --- must be filled in before the API will start ---
# Production refuses console email delivery.
AUTH_EMAIL_PROVIDER_URL=
AUTH_EMAIL_PROVIDER_API_KEY=

# Mainnet RPC endpoints (comma separated lists are tried in order).
NETWORK_MODE=production
ETHEREUM_RPC_URLS=
ARBITRUM_RPC_URLS=
SOLANA_MAINNET_RPC_URLS=

LIFI_API_KEY=
LOG_LEVEL=info
EOF
  chmod 600 "$ENV_FILE"

  cat <<EOF

Created $ENV_FILE with generated secrets.

Before deploying, edit it and set:
  ACME_EMAIL                    a real mailbox for certificate notices
  CORS_ALLOWED_ORIGINS          your frontend origin(s)
  AUTH_EMAIL_PROVIDER_URL       + API key — production will not boot without them
  *_RPC_URLS                    mainnet RPC endpoints

Then point DNS at this server and run ./deploy.sh again.
EOF
  exit 0
fi

# ------------------------------------------------------------- sanity checks --
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

missing=()
[[ "${ACME_EMAIL:-}" == "CHANGE_ME@tsionmarket.com" || -z "${ACME_EMAIL:-}" ]] && missing+=(ACME_EMAIL)
[[ -z "${AUTH_EMAIL_PROVIDER_URL:-}" ]] && missing+=(AUTH_EMAIL_PROVIDER_URL)
[[ -z "${AUTH_EMAIL_PROVIDER_API_KEY:-}" ]] && missing+=(AUTH_EMAIL_PROVIDER_API_KEY)
[[ -z "${CORS_ALLOWED_ORIGINS:-}" ]] && missing+=(CORS_ALLOWED_ORIGINS)

if ((${#missing[@]})); then
  echo "These values in $ENV_FILE still need to be set:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

DOMAIN="${API_DOMAIN:-$DOMAIN_DEFAULT}"

echo "==> Checking DNS for $DOMAIN"
resolved="$(getent hosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | head -1 || true)"
if [[ -z "$resolved" ]]; then
  echo "    WARNING: $DOMAIN does not resolve yet."
  echo "    Add the Hostinger A record first or Let's Encrypt will fail."
  read -rp "    Continue anyway? [y/N] " reply
  [[ "$reply" == [yY] ]] || exit 1
else
  echo "    $DOMAIN -> $resolved"
fi

# --------------------------------------------------------------- deployment --
echo "==> Building images"
compose build

echo "==> Starting database"
compose up -d mysql

echo "==> Running migrations"
compose run --rm migrate

echo "==> Starting API and Caddy"
compose up -d api caddy

echo "==> Waiting for the API to report healthy"
for i in $(seq 1 30); do
  status="$(compose ps --format json api 2>/dev/null | grep -o '"Health":"[a-z]*"' | cut -d'"' -f4 || true)"
  if [[ "$status" == "healthy" ]]; then
    echo "    API is healthy."
    break
  fi
  if ((i == 30)); then
    echo "    API did not become healthy in time. Recent logs:" >&2
    compose logs --tail 40 api >&2
    exit 1
  fi
  sleep 2
done

echo "==> Verifying local endpoint"
curl -fsS "http://127.0.0.1:${API_LOCAL_PORT:-3456}/health" && echo

echo "==> Verifying public endpoint (TLS may take ~30s on first issue)"
for i in $(seq 1 15); do
  if curl -fsS "https://$DOMAIN/health" >/dev/null 2>&1; then
    echo "    https://$DOMAIN/health is live."
    break
  fi
  if ((i == 15)); then
    echo "    Public endpoint not reachable yet. Check: compose logs caddy" >&2
    echo "    (DNS propagation or firewall on 80/443 are the usual causes.)" >&2
  fi
  sleep 4
done

echo
echo "Deployed. API: https://$DOMAIN"

if [[ "${1:-}" == "--logs" ]]; then
  compose logs -f api caddy
fi
