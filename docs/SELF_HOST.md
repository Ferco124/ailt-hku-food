# Self-hosting on a home server

The application is a single Node process with a SQLite file. It binds
`127.0.0.1`, so by default nothing outside the machine can reach it. This
runbook exposes it through a **Cloudflare Tunnel**: `cloudflared` runs on the
same host, dials out to Cloudflare's edge, and your domain points at the tunnel.

```text
visitor ──HTTPS──> Cloudflare edge ──tunnel (outbound from your box)──> cloudflared
                                                                            │
                                                              127.0.0.1:4173 │
                                                                            v
                                                                    node server/index.js
                                                                            │
                                                                    data/canteens.db
```

Consequences worth knowing before you start:

- No port forwarding, no static IP, no DDNS, and no inbound port open. The home
  router is untouched, and the box can sit behind CGNAT.
- TLS is Cloudflare's, so the certificate and renewal are not your problem.
- The server keeps binding loopback, which is why `HOST` stays `127.0.0.1`.
- The trade-off: the site is up only while the machine and the tunnel are.

The reference host is Ubuntu 26.04 LTS (apt + systemd); the only distro-specific
lines are the two package installs.

## 0. Prerequisites

- A domain whose DNS is hosted on Cloudflare (the tunnel's DNS record is created
  for you if so; otherwise you add a CNAME by hand, see step 5).
- `sudo` on the server.
- Node.js **22.16 or newer** — `node:sqlite` is unavailable in Node 18 and
  too old to be reliable in early 22.x.

## 1. Packages

```bash
sudo apt update
sudo apt install -y git nodejs
node --version      # must be >= v22.16
```

If the archive Node is older, install the current LTS instead:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Then the tunnel client, from Cloudflare's apt repository:

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-public-v2.gpg \
  | sudo tee /usr/share/keyrings/cloudflare-public-v2.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-public-v2.gpg] https://pkg.cloudflare.com/cloudflared any main' \
  | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt update && sudo apt install -y cloudflared
cloudflared --version
```

`sqlite3` is optional and only used for the maintenance commands in step 8.

## 2. Service account and checkout

The app runs as an unprivileged system user that owns its own directory.

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin hku
sudo mkdir -p /srv/hku-canteen-finder
sudo chown hku:hku /srv/hku-canteen-finder
sudo -u hku git clone <repository-url> /srv/hku-canteen-finder
```

For a private repository, add a read-only deploy key to `~hku/.ssh` and clone
with the SSH URL. Never leave the model key in a public repository.

## 3. Configuration

The key and the hosting switches live in `.env` in the checkout root. It is
git-ignored; keep it mode `600`.

```bash
sudo -u hku install -m 600 /dev/null /srv/hku-canteen-finder/.env
sudo -u hku editor /srv/hku-canteen-finder/.env
```

```dotenv
BAILIAN_API_KEY=sk-...
BAILIAN_BASE_URL=https://api.deepseek.com/v1
BAILIAN_MODEL=deepseek-chat

HOST=127.0.0.1
TRUST_PROXY=1
DAILY_REQUEST_BUDGET=300
STATS_TOKEN=<openssl rand -hex 24>
```

| Variable | Why it matters here |
|---|---|
| `HOST` | Keep `127.0.0.1`. The tunnel connects from this machine, so nothing needs a public listener. |
| `TRUST_PROXY` | `1` makes the app take the visitor address from `CF-Connecting-IP`. Without it every request looks like `127.0.0.1` and the whole internet shares one 30/minute bucket — the first busy minute returns 429 for everyone. Only set this when a proxy really is in front. |
| `DAILY_REQUEST_BUDGET` | Whole-process fuse on model spend, counted per Hong Kong day. `0` disables it. In memory, so a restart resets it. |
| `STATS_TOKEN` | `/api/stats` returns the last five queries plus the database path. Once `TRUST_PROXY=1` the route is a 404 unless `Authorization: Bearer <token>` matches. |

`PORT` defaults to 4173 and only needs changing if something else owns it.

## 4. Smoke test before systemd

```bash
cd /srv/hku-canteen-finder
sudo -u hku npm test                                   # 64 tests, no dependencies
sudo -u hku node server/index.js                       # Ctrl-C once the banner looks right
```

The banner should show `http://127.0.0.1:4173`, `proxy client address from …`,
`stats token required`, and `budget 300 searches per Hong Kong day`. From a
second terminal:

```bash
curl -s http://127.0.0.1:4173/api/health
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4173/api/stats   # 404
```

## 5. The tunnel

### Dashboard-managed (recommended)

1. Zero Trust dashboard → **Networks → Tunnels → Create a tunnel → Cloudflared**.
2. Name it `hku-canteen` and copy the token it shows.
3. On the server: `sudo cloudflared service install <token>`. This writes and
   starts its own systemd unit; do not also install `deploy/cloudflared.service`.
4. In the tunnel's **Public Hostnames** tab: subdomain `canteen`, domain
   `yourdomain.com`, service `http://localhost:4173`.
5. The proxied DNS record is created automatically when the zone is on
   Cloudflare. If the domain is registered elsewhere, add
   `CNAME canteen → <tunnel-id>.cfargotunnel.com` (proxied) at your registrar.

### Self-managed (credentials stay on the host)

Use this when you would rather keep the tunnel definition in the repository. It
uses `deploy/cloudflared.service`.

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin cloudflared
sudo -u cloudflared cloudflared tunnel login        # paste the printed URL in a browser
sudo -u cloudflared cloudflared tunnel create hku-canteen
sudo -u cloudflared cloudflared tunnel route dns hku-canteen canteen.yourdomain.com
```

`/home/cloudflared/.cloudflared/config.yml`:

```yaml
tunnel: hku-canteen
credentials-file: /home/cloudflared/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: canteen.yourdomain.com
    service: http://127.0.0.1:4173
  - service: http_status:404
```

```bash
sudo cp deploy/cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared
```

## 6. Run the app under systemd

```bash
sudo cp deploy/hku-canteen.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hku-canteen
systemctl status hku-canteen --no-pager
journalctl -u hku-canteen -f
```

The unit runs as `hku`, keeps the filesystem read-only except
`/srv/hku-canteen-finder/data` (SQLite needs to write there), and restarts on
failure.

## 7. Close the network, then verify from outside

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw enable
ss -ltnp | grep 4173      # expect 127.0.0.1:4173, never 0.0.0.0:4173
```

Do not open 80/443 and do not forward anything on the router. Then, from a
machine that is not the server:

```bash
curl -s https://canteen.yourdomain.com/api/health | head -c 200
curl -s -o /dev/null -w '%{http_code}\n' https://canteen.yourdomain.com/api/stats   # 404
curl -s -H "Authorization: Bearer $STATS_TOKEN" https://canteen.yourdomain.com/api/stats | head -c 300
```

A real search in the browser should return cards. Two checks that the hosting
switches are actually doing something:

- Load the site from two devices at once and search. If the second device is
  immediately rate-limited, `TRUST_PROXY` is not in effect (or the header is
  missing) and every visitor is sharing one bucket.
- Search more than `DAILY_REQUEST_BUDGET` times in a day and confirm the site
  starts returning “daily search limit” instead of quietly spending money.

## 8. Operating it

```bash
# Update
cd /srv/hku-canteen-finder
sudo -u hku git pull
sudo -u hku npm test
sudo systemctl restart hku-canteen

# Logs
journalctl -u hku-canteen -n 100 --no-pager
journalctl -u cloudflared -n 100 --no-pager

# Backup (state = database + .env)
sudo tar czf /var/backups/hku-canteen-$(date +%F).tgz -C /srv/hku-canteen-finder data .env

# Prune the query log after 30 days (every visitor query is stored)
sudo -u hku sqlite3 data/canteens.db \
  "delete from search_log where created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 day');"

# Rotate the model key or the stats token: edit .env, then
sudo systemctl restart hku-canteen
```

Put the prune line in `hku`'s crontab (`crontab -u hku -e`, `@weekly …`) if the
site sees traffic.

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Cloudflare error 1033 / 502 | The app is down or the tunnel is not running: `systemctl status hku-canteen cloudflared`, then `journalctl`. |
| Site loads but every search says “too many requests” | `TRUST_PROXY=1` missing, or the request did not come through the tunnel. |
| 429 with `daily_budget` | The daily fuse tripped. Raise `DAILY_REQUEST_BUDGET` or wait for Hong Kong midnight. |
| `/api/stats` is 404 even with a token | The token in `.env` differs from the one sent, or the service was not restarted after editing `.env`. |
| “model offline” for every query | Provider key or base URL wrong: `sudo -u hku npm run check-key`. |
| Opening hours look wrong | The host clock drifted: `timedatectl set-ntp true`, then `timedatectl`. |
| `Cannot find module 'node:sqlite'` | Node is older than 22.16. |
| `EADDRINUSE` on start | Something else owns 4173: `ss -ltnp \| grep 4173`. |

## 10. What is actually exposed

- Queries are sent to the configured model provider, and every query is written
  to `search_log` in the local database. Tell visitors, or prune aggressively.
- The model key never reaches the browser; it exists only in `.env` on the box.
- Cloudflare terminates TLS at its edge, so Cloudflare sees the traffic before
  re-encrypting it to the tunnel.
- The database and `.env` are the only state. Everything else is reproducible
  from the repository, which is why the backup is two files.