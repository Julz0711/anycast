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
| `XTREAM_URL`, `XTREAM_USERNAME`, `XTREAM_PASSWORD` | your provider login (same as on your PC) |
| `ANYCAST_SECRET` | a long random string; generate one with `openssl rand -hex 32` |
| `ANYCAST_ADMIN_USER`, `ANYCAST_ADMIN_PASSWORD` | the AnyCast login you'll use in the app |

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
The first sync of your ~195k items takes about a minute; the app is usable while it runs.

The container also appears in the CasaOS dashboard, where you can start, stop and see its logs.

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
come back from the provider on the next sync. It does contain the password and PIN *hashes*, so
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
