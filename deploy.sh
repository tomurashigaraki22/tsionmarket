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

# Share cookies with the frontend subdomain so a page reload can refresh the session.
AUTH_COOKIE_DOMAIN=.tsionmarket.com

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
# Email via Hostinger SMTP. Create the mailbox in hPanel > Emails first.
# Port 465 = implicit TLS (AUTH_SMTP_SECURE=true). Use 587 with false instead.
AUTH_EMAIL_DELIVERY_MODE=smtp
AUTH_SMTP_HOST=smtp.hostinger.com
AUTH_SMTP_PORT=465
AUTH_SMTP_SECURE=true
AUTH_SMTP_USER=no-reply@tsionmarket.com
AUTH_SMTP_PASSWORD=
AUTH_EMAIL_FROM="TsionMarket <no-reply@tsionmarket.com>"
# Where verification and reset links point (your frontend, not the API).
AUTH_EMAIL_LINK_BASE_URL=https://tsionmarket.com

# Mainnet RPC endpoints (comma separated lists are tried in order).
NETWORK_MODE=mainnet
ETHEREUM_RPC_URLS=
ARBITRUM_RPC_URLS=
SOLANA_MAINNET_RPC_URLS=

LIFI_API_KEY=

# OnSwitch payments stay disabled until the provider and corridor are approved.
# In production, use only a rotated live key from the deployment secret store.
ONSWITCH_ENABLED=false
ONSWITCH_ENVIRONMENT=live
ONSWITCH_ONRAMP_STARTS_ENABLED=true
ONSWITCH_OFFRAMP_STARTS_ENABLED=true
ONSWITCH_SANDBOX_SERVICE_KEY=
ONSWITCH_LIVE_SERVICE_KEY=
ONSWITCH_IDEMPOTENCY_SECRET=
ONSWITCH_DATA_ENCRYPTION_KEY=$(openssl rand -hex 32)
ONSWITCH_MAX_ACTIVE_OPERATIONS_PER_USER=5
ONSWITCH_TIMEOUT_MS=10000
ONSWITCH_CATALOGUE_TTL_SECONDS=900
ONSWITCH_WORKER_INTERVAL_SECONDS=20
ONSWITCH_WORKER_BATCH_SIZE=20
ONSWITCH_WORKER_MAX_ATTEMPTS=12
ONSWITCH_WORKER_LOCK_SECONDS=90
LOG_LEVEL=info
EOF
  chmod 600 "$ENV_FILE"

  cat <<EOF

Created $ENV_FILE with generated secrets.

Before deploying, edit it and set:
  ACME_EMAIL                    a real mailbox for certificate notices
  CORS_ALLOWED_ORIGINS          your frontend origin(s)
  AUTH_SMTP_PASSWORD            Hostinger mailbox password (hPanel > Emails)
  AUTH_SMTP_USER / _FROM        adjust if your mailbox is not no-reply@
  *_RPC_URLS                    mainnet RPC endpoints

OnSwitch remains disabled in this production stack by default. For controlled
pre-release sandbox testing, it can be enabled explicitly with the sandbox key
and payment secrets in deploy/.env; see docs/runbooks/onswitch-sandbox.md. Keep
provider keys server-side. Sandbox off-ramp testing must not request a real
mainnet wallet transfer. Set a separate random ONSWITCH_IDEMPOTENCY_SECRET (at
least 32 characters) before enabling payments. Keep the generated
ONSWITCH_DATA_ENCRYPTION_KEY backed up with restricted access; losing it makes
pending payment instructions unreadable.

Then point DNS at this server and run ./deploy.sh again.
EOF
  exit 0
fi

# ------------------------------------------------------------- sanity checks --
# Read values WITHOUT sourcing. Sourcing runs the file as shell, so a perfectly
# valid Compose value like `NAME=Tsion <no-reply@example.com>` would be parsed
# as a command plus redirects. Compose's own parser has no such problem.
env_value() {
  sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" \
    | tail -n 1 \
    | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/" \
    | sed -e 's/[[:space:]]*$//'
}

ACME_EMAIL="$(env_value ACME_EMAIL)"
CORS_ALLOWED_ORIGINS="$(env_value CORS_ALLOWED_ORIGINS)"
API_DOMAIN="$(env_value API_DOMAIN)"
API_LOCAL_PORT="$(env_value API_LOCAL_PORT)"
AUTH_EMAIL_DELIVERY_MODE="$(env_value AUTH_EMAIL_DELIVERY_MODE)"

missing=()
[[ "$ACME_EMAIL" == "CHANGE_ME@tsionmarket.com" || -z "$ACME_EMAIL" ]] && missing+=(ACME_EMAIL)
[[ -z "$CORS_ALLOWED_ORIGINS" ]] && missing+=(CORS_ALLOWED_ORIGINS)

case "${AUTH_EMAIL_DELIVERY_MODE:-smtp}" in
  smtp)
    [[ -z "$(env_value AUTH_SMTP_USER)" ]] && missing+=(AUTH_SMTP_USER)
    [[ -z "$(env_value AUTH_SMTP_PASSWORD)" ]] && missing+=(AUTH_SMTP_PASSWORD)
    [[ -z "$(env_value AUTH_EMAIL_FROM)" ]] && missing+=(AUTH_EMAIL_FROM)
    [[ -z "$(env_value AUTH_EMAIL_LINK_BASE_URL)" ]] && missing+=(AUTH_EMAIL_LINK_BASE_URL)
    ;;
  http)
    [[ -z "$(env_value AUTH_EMAIL_PROVIDER_URL)" ]] && missing+=(AUTH_EMAIL_PROVIDER_URL)
    [[ -z "$(env_value AUTH_EMAIL_PROVIDER_API_KEY)" ]] && missing+=(AUTH_EMAIL_PROVIDER_API_KEY)
    ;;
  *)
    echo "AUTH_EMAIL_DELIVERY_MODE must be 'smtp' or 'http' in production." >&2
    exit 1
    ;;
esac

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
