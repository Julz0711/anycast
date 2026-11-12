# Running AnyCast on a CasaOS home server

This gets the AnyCast server (API + web app) running as a Docker container on CasaOS. You do it
once; updating later is two commands. It takes about 15 minutes, most of it the first build.

> **Two ways to run it.** Steps 1–3 below build AnyCast from source with `docker compose`. Since
> GitHub now builds a ready-made image, you can instead install it as a regular CasaOS app, which
> also makes CasaOS's Settings/Edit screen safe to use: see [CasaOS app install](#casaos-app-install).
> Moving an existing install over keeps all your data.

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

AnyCast also shows up in the CasaOS dashboard as an app, with its icon and an Open button, where you
can start, stop and see its logs. The `x-casaos` block at the end of `docker-compose.yml` does that:
CasaOS reads it straight from this folder, so it updates with `git pull` like everything else. The
Open button goes to `http://<the address you opened CasaOS at>:8787`. To make it open your HTTPS
address instead, add to `.env` and run `docker compose up -d`:

```sh
ANYCAST_CASAOS_HOST=anycast.example.com
ANYCAST_CASAOS_SCHEME=https
ANYCAST_CASAOS_PORT=443
```

**With this install, don't change AnyCast's settings in the CasaOS UI** (the app's "Settings"/"Edit" screen, or
reinstalling it from there). CasaOS then rewrites the compose setup its own way, which has broken
AnyCast's ports and volumes before. Start, stop, restart and logs in the dashboard are safe. Change
everything else in `.env` or `docker-compose.yml` here and run `docker compose up -d`. If it happened
anyway: `cd /DATA/AppData/anycast && git checkout docker-compose.yml && docker compose up -d --build`
puts it back; your data stays in the volumes. The [CasaOS app install](#casaos-app-install) doesn't
have this problem.

**Your provider allows one connection.** Stop AnyCast on your PC (`pnpm dev`) once the server runs,
or the two will compete for it.

## 4. Optional: HTTPS and access from outside (recommended)

Installing AnyCast as an app on your phone needs HTTPS. The easiest way is Tailscale, which CasaOS
has in its App Store:

1. Install **Tailscale** from the CasaOS App Store and sign in.
2. Install the Tailscale app on your phone and PC with the same account.
3. On the server, run `sudo tailscale serve --bg 8787`.

AnyCast is then at `https://<server-name>.<your-tailnet>.ts.net`, with a valid certificate, from
anywhere, without opening ports on your router. On the phone, open it and use "Add to Home Screen".

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
  Without it, the TV is sent the `ts.net` address and can't play.

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

## CasaOS app install

Here CasaOS manages AnyCast like any other app (Settings/Edit screen included). GitHub builds the
image on every merge to `main` and keeps it private at `ghcr.io/julz0711/anycast`. Your data lives
in folders under `/DATA/AppData/anycast` instead of Docker volumes.

### Once: let the server pull the private image

1. On GitHub: **Settings → Developer settings → Personal access tokens → Tokens (classic) →
   Generate new token (classic)**. Tick only **read:packages**, pick an expiry, and copy it.
   (Fine-grained tokens can't read GitHub's image registry yet.) Don't share it with anyone.
2. On the server, log in as root, because that's who CasaOS pulls as:

   ```sh
   sudo docker login ghcr.io -u Julz0711
   ```

   Paste the token as the password. Then `sudo docker pull ghcr.io/julz0711/anycast:latest`
   should download the image.

### Moving over from the `docker compose` install

Do this once. Your accounts, profiles, favorites, progress and the saved provider login all come
along.

1. In the app, **Settings › All settings › Backup & restore → Download** a backup, just in case.
2. Write down the values from the old `.env` (you need `ANYCAST_SECRET` exactly as it is, or the
   saved provider login can't be read):

   ```sh
   cd /DATA/AppData/anycast
   grep -E '^(ANYCAST_|TRUST_PROXY)' .env
   ```

3. Stop the old install and move its folder out of the way (the volumes stay):

   ```sh
   docker compose down
   cd /DATA/AppData
   sudo mv anycast anycast-src
   ```

4. Copy the data out of the old volume into the new folder:

   ```sh
   sudo mkdir -p /DATA/AppData/anycast/data /DATA/AppData/anycast/buffer
   sudo docker run --rm -v anycast_anycast-data:/from -v /DATA/AppData/anycast/data:/to \
     --entrypoint cp ghcr.io/julz0711/anycast:latest -a /from/. /to/
   sudo ls /DATA/AppData/anycast/data    # should list anycast.db (and backups/)
   ```

   The rewind buffer isn't copied; it fills up again by itself.

5. Show the CasaOS compose file and copy it:

   ```sh
   cat /DATA/AppData/anycast-src/casaos/anycast.yml
   ```

6. In CasaOS: **App Store → Custom Install** (the `+` at the top right), then **Import**, and paste
   it. Before you press Install, fill in the lines marked `FILL IN`: `ANYCAST_SECRET` from step 2,
   an admin password (only used on a fresh install), and `TRUST_PROXY: "true"` because you use
   Nginx Proxy Manager. Then **Install**.
7. Open AnyCast as before (https://anycast.gtkncht.com, or `http://<server-ip>:8787`) and sign in
   with your usual account.

When everything is there, you can delete the old volumes:
`docker volume rm anycast_anycast-data anycast_anycast-buffer`. Keep `/DATA/AppData/anycast-src`
if you want to run the doctor (`cd /DATA/AppData/anycast-src && docker compose run --rm anycast
node_modules/.bin/tsx src/doctor/cli.ts`); otherwise delete it too.

**If something goes wrong:** uninstall AnyCast in CasaOS, then
`cd /DATA/AppData && sudo mv anycast anycast-new && sudo mv anycast-src anycast && cd anycast && docker compose up -d`
brings the old install back, with its volumes untouched.

### Updating the CasaOS app

After a merge, wait for the **Image** run on GitHub (Actions tab) to turn green, then:

```sh
sudo docker pull ghcr.io/julz0711/anycast:latest
sudo docker compose -p anycast -f /var/lib/casaos/apps/anycast/docker-compose.yml up -d
```

Saving AnyCast's Settings screen in CasaOS should do the same (CasaOS pulls the image before it
restarts the app), so that works as an update button too. Every build is also tagged with its commit (`sha-1a2b3c4`), so
you can go back to an older one by putting that tag instead of `latest` in the Settings screen.

### Settings in the CasaOS app

Everything that was in `.env` is now in AnyCast's **Settings** screen in CasaOS (environment
variables). Change it there and save. For hardware encoding, add the device `/dev/dri` there.

## Updating

For the `docker compose` install (the CasaOS app updates differently, see above):

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
- **Port 8787 is taken:** change the left side of `"8787:8787"` in `docker-compose.yml`, e.g. `"8790:8787"`.
- **Provider check:** `docker compose exec anycast node_modules/.bin/tsx src/doctor/cli.ts` runs the
  doctor inside the container (FFmpeg is included there, so you also get stream formats).
  The doctor reads the `XTREAM_*` lines from `.env`, so it needs them even if you entered the login in the app.
- **"The provider rejected this username or password":** check the login in Settings › Provider
  (admin). Leave the password empty to keep the saved one, or type it again. If `.env` has `XTREAM_*`
  lines, editing them there and restarting also replaces the login.
