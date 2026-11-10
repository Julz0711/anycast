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

Installing AnyCast as an app on your phone needs HTTPS. The easiest way is Tailscale, which CasaOS
has in its App Store. It reaches your server from anywhere without opening ports on your router, and
only your own devices (with the Tailscale app) can get in.

1. Install **Tailscale** from the CasaOS App Store and sign in.
2. Install the Tailscale app on your phone and PC with the same account.
3. On the server, run `sudo tailscale serve --bg 8787`.

AnyCast is then at `https://<server-name>.<your-tailnet>.ts.net`, with a valid certificate. On the
phone, open it and use "Add to Home Screen". To use a name of your own instead, see 4a.

## 4a. Optional: your own domain over Tailscale

This puts AnyCast at `https://tv.<your-domain>` (e.g. `tv.example.com`). It is still private: the
name points at the server's Tailscale address, which only devices in your tailnet can reach. No
port forwarding, and it works behind DS-Lite/CGNAT.

```
phone (Tailscale on) ──https──> tv.example.com = 100.x.y.z ──tailnet──> Nginx Proxy Manager ──> AnyCast :8787
```

You need: Tailscale set up as in step 4 (steps 1 and 2), a domain, and a free Cloudflare account
for the domain's DNS. Cloudflare is only used for DNS here, not for your traffic: the certificate
needs a DNS provider with an API, which most registrars don't offer.

**1. Find the server's Tailscale address.** Open https://login.tailscale.com/admin/machines. Your
server's row shows an address like `100.101.102.103`. In its `…` menu choose **Disable key expiry**,
otherwise the server drops off the tailnet after 180 days.

**2. Stop `tailscale serve`** if you set it up in step 4, because it occupies port 443 (do this right before step 6, so the `ts.net` address keeps working until then):
`sudo tailscale serve reset`. (Without a `tailscale` command on the host: CasaOS dashboard ›
Tailscale app › terminal, same command.)

**3. Move the DNS to Cloudflare.** Sign up at https://dash.cloudflare.com, **Add a domain**, enter
your domain, pick the **Free** plan. Cloudflare shows two nameservers (like `ada.ns.cloudflare.com`).
At your registrar, replace the domain's nameservers with these two. The domain stays registered
where it is. Cloudflare emails you when it's active (minutes to a few hours).

**4. Add the DNS record** in Cloudflare › your domain › DNS › Records › Add record:

| Type | Name | IPv4 address | Proxy status |
|---|---|---|---|
| A | `tv` | the Tailscale address from step 1 | **DNS only** (grey cloud) |

**5. Create an API token** for the certificate: Cloudflare › My Profile › API Tokens › Create Token ›
template **Edit zone DNS** › Zone Resources: *Include, Specific zone,* your domain › Continue ›
Create Token. Copy it (shown once).

**6. Install Nginx Proxy Manager** from the CasaOS App Store. NPM wants host ports 80, 81 and 443,
and the CasaOS dashboard already uses 80. With the DNS challenge, NPM doesn't need port 80, so leave
CasaOS alone: in the install dialog (or later via the app's `…` › Settings), change the host port
for NPM's container port **80** to a free one, e.g. `8081`. Keep **443** on 443 and **81** on 81.
(Don't move the CasaOS dashboard port instead; that can stop the dashboard from starting.)

**7. Sign in to NPM** at `http://<server-ip>:81` (first sign-in: `admin@example.com` / `changeme`,
it asks you to change both).

**8. Get the certificate:** NPM › SSL Certificates › Add SSL Certificate › Let's Encrypt.
Domain Names `tv.example.com`, turn on **Use a DNS Challenge**, DNS Provider **Cloudflare**, and in
Credentials File Content replace the sample token so the line reads
`dns_cloudflare_api_token = <your token>`. Agree and Save. It takes a minute.

**9. Add the proxy host:** NPM › Hosts › Proxy Hosts › Add Proxy Host.

- *Details:* Domain Names `tv.example.com`, Scheme `http`, Forward Hostname/IP the server's home IP
  (e.g. `192.168.1.20`), Forward Port `8787`. Turn on **Block Common Exploits** and **Websockets Support**.
- *SSL:* pick the certificate from step 8, turn on **Force SSL** and **HTTP/2 Support**.
- *Advanced:* paste these lines, so live TV isn't held back or cut off by the proxy:

  ```
  proxy_buffering off;
  proxy_request_buffering off;
  proxy_read_timeout 1h;
  proxy_send_timeout 1h;
  ```

**10. Tell AnyCast it sits behind a proxy.** Add `TRUST_PROXY=true` to `.env` and restart with
`docker compose up -d`. Without it AnyCast sees every visitor as the proxy, so the sign-in limit
(10 tries a minute) would apply to everyone at once, and sign-in cookies aren't marked https-only.

Open `https://tv.example.com` on a device with Tailscale switched on and use "Add to Home Screen".
The certificate renews itself.

**If the name doesn't resolve** (often on home Wi-Fi, where the router blocks DNS answers that
point to private addresses): Tailscale admin › DNS › Global nameservers › add `1.1.1.1` and turn on
**Override DNS servers**. Devices with Tailscale on then look names up through Cloudflare.

**Public instead of private:** to reach AnyCast from devices without Tailscale, point the record
at your home IP (needs a public IPv4, not DS-Lite), forward TCP 80 and 443 on your router to the
server, and use the same NPM setup. The sign-in page is then on the internet, so use a long admin
password.

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
  Without it, the TV is sent the `ts.net` address and can't play. The same goes for your own domain (4a).

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
- **Own domain doesn't load:** check in order: Tailscale is on on that device; `nslookup tv.<your-domain>`
  prints the server's `100.x` address (if not, see "If the name doesn't resolve" in 4a); the NPM
  certificate was issued (NPM › SSL Certificates); `tailscale serve` is off (4a step 2).
- **Port 8787 is taken:** change the left side of `"8787:8787"` in `docker-compose.yml`, e.g. `"8790:8787"`.
- **Provider check:** `docker compose exec anycast node_modules/.bin/tsx src/doctor/cli.ts` runs the
  doctor inside the container (FFmpeg is included there, so you also get stream formats).
  The doctor reads the `XTREAM_*` lines from `.env`, so it needs them even if you entered the login in the app.
- **"The provider rejected this username or password":** check the login in Settings › Provider
  (admin). Leave the password empty to keep the saved one, or type it again. If `.env` has `XTREAM_*`
  lines, editing them there and restarting also replaces the login.
