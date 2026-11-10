# Running AnyCast on a CasaOS home server

This gets the AnyCast server (API + web app) running as a Docker container on CasaOS. You do it
once; updating later is two commands. It takes about 15 minutes, most of it the first build.

## What you need

- SSH access to the server (CasaOS: the terminal icon in the dashboard works too, or `ssh you@server-ip`
  from Windows Terminal).
- A GitHub token, because the repository is private: on GitHub go to **Settings → Developer settings →
  Personal access tokens → Fine-grained tokens → Generate new token**, give it access to only
  `Julz0711/anycast` with **Contents: Read-only**, and copy it. Don't share it with anyone.

## 1. Get the code onto the server

```sh
sudo mkdir -p /DATA/AppData/anycast
sudo chown "$USER" /DATA/AppData/anycast
cd /DATA/AppData/anycast
git clone https://github.com/Julz0711/anycast.git .
```

When git asks for a username, type `Julz0711`; as the password, paste the token.
(Until the first pull request is merged, add `-b m0-foundations` to the clone command.)

If `git` is missing: `sudo apt install -y git`.

## 2. Create the `.env`

```sh
cp .env.example .env
nano .env
```

Fill in:

| Line | Value |
|---|---|
| `ANYCAST_SECRET` | a long random string; generate one with `openssl rand -hex 32` |
| `ANYCAST_ADMIN_USER`, `ANYCAST_ADMIN_PASSWORD` | the AnyCast login you'll use in the app |
| `XTREAM_URL`, `XTREAM_USERNAME`, `XTREAM_PASSWORD` | optional: leave them empty and enter your provider login in the app (step 3) |

If you already filled in the `XTREAM_*` lines, that's fine too: AnyCast uses them, and you can still
change the login in the app later.

Leave `PORT`, `DATA_DIR` and `BUFFER_DIR` as they are (the container sets the paths itself).
Save with Ctrl+O, Enter, then Ctrl+X.

## 3. Build and start

```sh
docker compose up -d --build
```

The first build takes 5–10 minutes. Then check it's healthy:

```sh
docker compose ps        # STATUS should say "healthy" after ~30 s
docker compose logs -f   # Ctrl+C to stop watching; the first catalog sync shows up here
```

Open `http://<server-ip>:8787` in a browser and sign in with the admin login from `.env`.
Without `XTREAM_*` in `.env`, AnyCast now asks for your provider: enter the server address,
username and password from your IPTV provider (or paste your whole playlist link into the address
field), press **Test login**, then **Connect**. The password is stored encrypted with
`ANYCAST_SECRET` and is never shown again. To change it later: **Settings › Provider** (admin only).

The first sync of your ~195k items takes about a minute; the app is usable while it runs.

The container also appears in the CasaOS dashboard, where you can start, stop and see its logs.

**Your provider allows one connection.** Stop AnyCast on your PC (`pnpm dev`) once the server runs,
or the two will compete for it.

## 4. Optional: HTTPS and access from outside (recommended)

Installing AnyCast as an app on your phone needs HTTPS. There are two ways:

- **Your own domain** (e.g. `https://tv.example.com`): works on any device, nothing to install on
  it, but the AnyCast sign-in page is on the internet. See [4a](#4a-your-own-domain).
- **Tailscale**: private, only your own devices with the Tailscale app can reach it. Below.

CasaOS has Tailscale in its App Store:

1. Install **Tailscale** from the CasaOS App Store and sign in.
2. Install the Tailscale app on your phone and PC with the same account.
3. On the server, run `sudo tailscale serve --bg 8787`.

AnyCast is then at `https://<server-name>.<your-tailnet>.ts.net`, with a valid certificate, from
anywhere, without opening ports on your router. On the phone, open it and use "Add to Home Screen".

## 4a. Your own domain

This puts AnyCast at `https://tv.<your-domain>` with a free Let's Encrypt certificate, reachable
from anywhere. The parts: your domain points at your home's internet address, your router passes
web traffic to the server, and Nginx Proxy Manager (NPM) on the server handles HTTPS and hands
requests to AnyCast.

```
phone ──https──> tv.example.com ──DNS──> your home IP ──router 80/443──> NPM ──http──> AnyCast :8787
```

**0. Check your line can take incoming connections.** In your router's status page, compare the
internet (WAN) IPv4 address with what https://whatismyip.com shows. If they differ, or the router's
address starts with `100.64.` to `100.127.`, you're behind CGNAT and port forwarding can't work.
Ask your internet provider for a public IPv4 address (often free, sometimes called "Dual Stack"
instead of "DS-Lite"), or use Tailscale instead.

**1. A name that follows your home IP.** Home IP addresses change now and then, so the domain
points at a name that updates itself:

- **FRITZ!Box:** turn on MyFRITZ! (Internet › MyFRITZ! Account). It gives you an address like
  `abc123.myfritz.net` that always points home.
- **Any other router:** create a free name at https://www.duckdns.org (e.g. `julz-home.duckdns.org`)
  and enter it in the router's "Dynamic DNS" settings with the DuckDNS token. If the router has no
  DuckDNS option, install **DuckDNS** from the CasaOS App Store instead.

**2. DNS at your domain registrar.** Add a record:

| Type | Name | Value |
|---|---|---|
| CNAME | `tv` | the name from step 1, e.g. `julz-home.duckdns.org` |

It can take up to an hour to work. Check with `nslookup tv.example.com`: it should print your home IP.

**3. Free ports 80 and 443 on the server.** The CasaOS dashboard itself uses port 80. Move it:
CasaOS dashboard › Settings (gear) › WebUI port, e.g. `8080`. The dashboard is then at
`http://<server-ip>:8080`.

**4. Install Nginx Proxy Manager** from the CasaOS App Store. Its admin page is at
`http://<server-ip>:81` (first sign-in: `admin@example.com` / `changeme`, it asks you to change both).

**5. Forward the ports on your router** to the server's home IP: TCP **80** and TCP **443**. Port 80
is needed for the certificate (and NPM sends visitors on to https). Don't forward 8787 or 81.

**6. Add the proxy host in NPM:** Hosts › Proxy Hosts › Add Proxy Host.

- *Details:* Domain Names `tv.example.com`, Scheme `http`, Forward Hostname/IP the server's home IP
  (e.g. `192.168.1.20`), Forward Port `8787`. Turn on **Block Common Exploits** and **Websockets Support**.
- *SSL:* Request a new SSL certificate, turn on **Force SSL** and **HTTP/2 Support**, agree, Save.
- *Advanced:* paste these lines, so live TV isn't held back or cut off by the proxy:

  ```
  proxy_buffering off;
  proxy_request_buffering off;
  proxy_read_timeout 1h;
  proxy_send_timeout 1h;
  ```

**7. Tell AnyCast it sits behind a proxy.** Add `TRUST_PROXY=true` to `.env` and restart with
`docker compose up -d`. Without it AnyCast sees every visitor as the proxy, so the sign-in limit
(10 tries a minute) would apply to everyone at once, and sign-in cookies aren't marked https-only.

Open `https://tv.example.com` on your phone (on mobile data, to be sure it works from outside) and
use "Add to Home Screen". Because the sign-in page is now public, use a long admin password and give
each person their own account.

## 4b. Casting to a TV (Chromecast, AirPlay)

The player has a cast button when a TV is on your network: Chromecast (and TVs with Chromecast
built in, like most Sony Android TVs) from Chrome or Edge, AirPlay from Safari on iPhone, iPad and
Mac. The TV plays the stream your server already makes for the app, so it never needs a second
provider connection, and the phone becomes the remote (play, pause, seek, zap).

Two things to know:

- **Chromecast needs the app opened over https** (step 4). That is a Chrome rule for casting.
- **The TV opens the stream from your server itself**, and it is not on your tailnet. So in the
  app, open Settings › All settings › Casting and set **Server address for TVs** to the server's
  home network address, e.g. `http://192.168.1.20:8787` (the address you opened in step 3).
  Without it, the TV is sent the `ts.net` address and can't play. With your own domain (4a) the
  TV can usually play the https address too, but the home address keeps the video inside your
  network, so set it anyway.

## 5. Optional: Hardware transcoding

Most streams play without any conversion. When a device can't decode a stream's video (HEVC on
an older browser, say), the server converts it to H.264, which costs a lot of CPU. With a GPU
passed into the container, it uses the GPU instead. Nothing to do if you don't need it: without
a GPU, AnyCast simply uses the CPU.

**Intel (most mini PCs and NAS boxes) or AMD:**

1. Check the server has a GPU device: `ls /dev/dri` should list `renderD128`.
2. In `docker-compose.yml`, uncomment the two `devices:` lines under "Hardware transcoding".
3. Restart: `docker compose up -d`.
4. In the app, open Settings › All settings › Diagnostics: **Video encoder** should say
   `VAAPI (h264_vaapi)`. If it says Software, the hint under it says what the test found.

To check from the server itself: `docker compose exec anycast vainfo` lists what the GPU can do
(look for `VAProfileH264` with `VAEntrypointEncSlice` or `VAEntrypointEncSliceLP`).

**NVIDIA:** install the NVIDIA Container Toolkit on the host, uncomment the `deploy:` block in
`docker-compose.yml` instead, and restart. Diagnostics should then say `NVIDIA NVENC (h264_nvenc)`.

By default (`ANYCAST_HWACCEL=auto`) the server tries NVENC, VAAPI and Quick Sync with a one second
test encode at startup and uses the first that works. An admin can force one, or turn it off, in
Settings › All settings › Player › Hardware encoding (the **Check again** button there re-runs the
test). If the GPU fails during playback, that stream carries on with the CPU and the GPU is left
alone for 15 minutes.

The GPU drivers add about 50 MB to the image. To build without them:
`docker compose build --build-arg HWACCEL_DRIVERS=0`.

## Updating

```sh
cd /DATA/AppData/anycast
git pull
docker compose up -d --build
```

Your data (accounts, favorites, progress, settings, rewind buffer) lives in Docker volumes and
survives updates. To be safe across a rebuild or a move to another server, keep a backup (see
[Backups](#backups)).

## Backups

Your accounts, profiles, favorites, progress (Continue watching and what you've watched), channel
lists, settings, filters, parental PINs and pinned channels can be saved to one file. The file
never contains your provider login, sign-in sessions or `ANYCAST_SECRET`; the catalog and guide
come back from the provider on the next sync (on a new server, enter the provider login again in
the app first). It does contain the password and PIN *hashes*, so
keep it somewhere private.

**Automatic:** once a day the server writes `anycast-backup-YYYY-MM-DD.json` to `/data/backups`
inside the container (the `anycast-data` volume) and keeps the last 7. Set `ANYCAST_BACKUP_KEEP` in
`.env` to keep more or fewer, or `0` to turn them off. A restore also saves the data it replaces
there first (`...-before-restore.json`).

**In the app (admins):** Settings › All settings › Backup & restore. Download a backup now or one of
the automatic ones, or restore from a file. Restoring shows what the file holds and asks for your
password. *Replace everything* swaps all accounts and profiles for the backup's; *Merge* keeps
what is there and only adds what is missing. The account you're signed in with always stays able
to sign in.

**Copy a backup off the server** (to keep it safe before rebuilding or moving):

```sh
cd /DATA/AppData/anycast
docker compose exec anycast ls -l /data/backups
docker compose cp anycast:/data/backups/anycast-backup-2026-11-06.json ./
```

Then copy it to your PC, e.g. `scp you@server-ip:/DATA/AppData/anycast/anycast-backup-2026-11-06.json .`

**Restore without the web app** (e.g. on a new server, or when you can't sign in): copy the file in
and run the restore command while AnyCast is stopped. Add `--merge` to keep existing data.

```sh
docker compose up -d && docker compose cp ./anycast-backup-2026-11-06.json anycast:/data/restore.json
docker compose stop
docker compose run --rm anycast node --import tsx src/backup/cli.ts /data/restore.json --yes
docker compose up -d
```

Outside Docker: `pnpm --filter @anycast/server run restore path/to/anycast-backup-2026-11-06.json`.
After a restore, sign in with the accounts and passwords from the backup.

## Troubleshooting

- **Container keeps restarting:** `docker compose logs` shows why. Usually a missing or short
  `ANYCAST_SECRET` (needs 16+ characters).
- **Can't sign in:** the admin account is created on the very first start. If you changed
  `ANYCAST_ADMIN_*` afterwards, reset with `docker compose down`, `docker volume rm anycast_anycast-data`,
  `docker compose up -d` (this deletes AnyCast's own data, not anything at your provider).
- **Own domain doesn't load from outside:** check in order: `nslookup tv.<your-domain>` prints your
  home IP; the NPM certificate was issued (NPM › SSL Certificates); ports 80 and 443 are forwarded to
  the server; you're not behind CGNAT (4a step 0). Testing from inside your home network can fail
  on some routers even when it works from outside, so test on mobile data.
- **Port 8787 is taken:** change the left side of `"8787:8787"` in `docker-compose.yml`, e.g. `"8790:8787"`.
- **Provider check:** `docker compose exec anycast node_modules/.bin/tsx src/doctor/cli.ts` runs the
  doctor inside the container (FFmpeg is included there, so you also get stream formats).
  The doctor reads the `XTREAM_*` lines from `.env`, so it needs them even if you entered the login in the app.
- **"The provider rejected this username or password":** check the login in Settings › Provider
  (admin). Leave the password empty to keep the saved one, or type it again. If `.env` has `XTREAM_*`
  lines, editing them there and restarting also replaces the login.
