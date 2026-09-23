# Deploying api.tsionmarket.com

One command on a fresh Ubuntu VPS. Caddy handles TLS automatically; the API
listens on **3456** behind it.

```
Internet ──443──> Caddy ──> api:3456 ──> mysql (internal only)
```

## 1. DNS in Hostinger

In **hPanel → Domains → tsionmarket.com → DNS / Nameservers**, add:

| Type | Name  | Points to          | TTL  |
| ---- | ----- | ------------------ | ---- |
| A    | `api` | your VPS IPv4      | 3600 |

That creates `api.tsionmarket.com`. If the VPS has IPv6, add an `AAAA` record
with the same name.

Do this **before** deploying — Let's Encrypt validates over HTTP and will fail
if the name does not resolve. Check it with:

```bash
dig +short api.tsionmarket.com
```

## 2. Server prerequisites

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out and back in
```

Open the firewall — only 80 and 443 need to be public:

```bash
sudo ufw allow 80,443/tcp
sudo ufw enable
```

Port 3456 is **not** opened. It is published to `127.0.0.1` only, so the API is
reachable from the host for debugging but never directly from the internet.

## 3. Deploy

```bash
git clone <repo> tsionmarket && cd tsionmarket
./deploy.sh
```

The first run writes `deploy/.env` with freshly generated secrets and stops.
Fill in the values it lists, then run it again:

```bash
./deploy.sh
```

It builds, migrates, starts, and verifies both `127.0.0.1:3456/health` and
`https://api.tsionmarket.com/health`.

## 4. What you must fill in

The production config **refuses to start** with development defaults, so these
have no safe fallback:

| Variable                      | Why                                                |
| ----------------------------- | -------------------------------------------------- |
| `ACME_EMAIL`                  | Let's Encrypt expiry notices                        |
| `CORS_ALLOWED_ORIGINS`        | Your frontend origin(s), comma separated            |
| `AUTH_EMAIL_PROVIDER_URL`     | Production rejects console email delivery           |
| `AUTH_EMAIL_PROVIDER_API_KEY` | Same                                                |
| `*_RPC_URLS`                  | Mainnet RPC endpoints for balances and transactions |

Generated for you: database passwords, all four auth secrets, and the metrics
bearer token. They are 48 characters each — the config enforces a 16-character
minimum on database passwords in production.

## 5. Everyday commands

```bash
cd deploy
alias dc='docker compose --env-file .env -f docker-compose.prod.yml'

dc ps                     # status
dc logs -f api            # follow API logs
dc restart api            # restart just the API
dc exec mysql mysql -uroot -p   # database shell
```

Update to a new release:

```bash
git pull && ./deploy.sh
```

Migrations run before the API starts, and the API only starts if they succeed.

## 6. Backups

The database lives in the `tsionmarket_mysql_data` volume. Dump it regularly:

```bash
cd deploy
docker compose --env-file .env -f docker-compose.prod.yml exec mysql \
  mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction tsionmarket \
  | gzip > "backup-$(date +%F).sql.gz"
```

Keep `deploy/.env` backed up somewhere safe and separate. Losing
`AUTH_PASSWORD_PEPPER` invalidates every stored password hash; losing
`AUTH_REFRESH_TOKEN_PEPPER` logs everyone out.

## 7. Notes on the security posture

- MySQL publishes **no** host port at all; reach it via `docker compose exec`.
- The API publishes to `127.0.0.1:3456` only.
- `TRUST_PROXY_HOPS=1` matches exactly one proxy (Caddy), so rate limiting sees
  real client IPs and cannot be spoofed by a forged `X-Forwarded-For`.
- `/metrics` is returned as 404 at the edge. Scrape it from the host on
  `127.0.0.1:3456/metrics` with the bearer token instead.
- The migration user is separate from the app user, so the running API cannot
  execute DDL.

If you later put Cloudflare in front, set `TRUST_PROXY_HOPS=2` — otherwise the
client IP will be read from the wrong header position.
