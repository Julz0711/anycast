# Opening AnyCast to the internet

Tailscale is still the safest way in. Some devices can't run it, though (a Fire TV Stick on Vega OS,
a hotel TV, a friend's laptop). This guide gives AnyCast a public address for them, while your own
phone and PC keep using Tailscale and the rest of the server stays home-only.

Two ways, pick one:

- **[A. Cloudflare Tunnel](#a-cloudflare-tunnel)**: no router change, free. Cloudflare's terms don't
  allow serving lots of video through it, so heavy use can get throttled.
- **[B. Router port forward](#b-router-port-forward)**: video goes straight from your router, but it
  needs a public IPv4 and an open port 443.

What protects AnyCast then:

- **No passwords from the internet.** A password signs in only from the home network or Tailscale.
  From the internet, AnyCast doesn't even check it (`ANYCAST_PASSWORD_OUTSIDE`, off by default), so
  guessing passwords from outside gets nowhere.
- **Devices outside sign in with your phone.** The TV (or a browser away from home) shows a code
  and a QR code; your phone, signed in over Tailscale, approves it (scan, or *Settings › Security ›
  Sign in a TV*). The approval page shows whether the device is at home or on the internet, so a
  code someone sent you stands out. Signing in that way needs your unlocked, signed-in phone.
- **Lockouts.** 10 wrong passwords from one address lock that address out for 15 minutes; asking
  for TV codes is rate-limited too.
- **Signed-in devices.** *Settings › Security* lists every device with where it was last seen and
  how it signed in. Sign out anything you don't recognize.

## A. Cloudflare Tunnel

`cloudflared` on the server opens an outgoing connection to Cloudflare; visitors reach AnyCast
through it. Nothing on the router changes and your home IP stays hidden.

Use a **new hostname** for it, e.g. `play.<your-domain>`, and keep `anycast.<your-domain>` on
Tailscale: your phone and PC then stay on the direct Tailscale path (faster, and no video through
Cloudflare), and only devices without Tailscale use the tunnel. AnyCast treats everything that comes
through Cloudflare as the internet, so a password never signs in there: devices sign in with your
phone.

1. **Create the tunnel.** Cloudflare dashboard › *Zero Trust* › *Networks* › *Tunnels* › *Create a
   tunnel* › *Cloudflared* › name `anycast` › *Save*. Under *Install and run a connector* pick
   *Docker* and copy the long token after `--token` (keep it secret: it is the tunnel's password).
2. **Run cloudflared on the server.** CasaOS › App Store › *Custom Install*:
   - Docker image `cloudflare/cloudflared:latest`, title `cloudflared`
   - Network: `host`
   - Command: `tunnel --no-autoupdate run --token <the token>`
   - Restart policy: `unless-stopped`

   Install. Back in Cloudflare the connector shows *Healthy* after a few seconds.
3. **Public hostname.** In the tunnel › *Public Hostname* › *Add a public hostname*: subdomain
   `play`, domain `<your-domain>`, service type `HTTP`, URL `localhost:8787`. Save. Cloudflare
   creates the DNS record itself; the wildcard `*` record stays as it is.
4. **No caching.** Cloudflare › your domain › *Caching* › *Cache Rules* › *Create rule*: hostname
   equals `play.<your-domain>`, action *Bypass cache*. (AnyCast already marks its responses private;
   this makes sure.)
5. **Check.** On mobile data with Tailscale off, open `https://play.<your-domain>`: the password is
   refused and AnyCast shows a code. Approve it on your phone (scan, or *Settings › Security ›
   Sign in a TV*). Under *Signed-in devices* the new device shows *internet* with your mobile IP.

To close it again: delete the public hostname (or the whole tunnel) in Cloudflare and remove the
cloudflared app.

## B. Router port forward

### Why consider it

Cloudflare's proxy and Tunnel are free, but their terms don't allow serving a lot of video through
them, and video is all AnyCast serves. Accounts that do get throttled or blocked. A port forward
sends the video straight from your router, at your own upload speed, with nothing in between. The
DNS record stays **DNS only** (grey cloud); the cost is that your home IP is visible in DNS.



### 1. Check that your line has a public IPv4

1. In the router's overview, find the **internet / WAN IPv4 address**.
2. On a phone on Wi-Fi, open <https://ifconfig.me> (or search "what is my IP").
3. Same address: port forwarding works. Go on.
   - Router shows `100.64.x.x`–`100.127.x.x`, `10.x`, `192.168.x`, or "DS-Lite": your provider
     shares an IPv4 with other customers, and forwarding can't work. Ask the provider for a public
     IPv4 (many switch it on for free, often called "Dual Stack" or "public IPv4"). Otherwise use
     Cloudflare Tunnel and accept the risk above.

### 2. Forward port 443 to Nginx Proxy Manager

In the router, forward **TCP 443** (external) to **192.168.0.232 port 443** (the server; NPM listens
there). Don't forward 80: the certificate already comes through the Cloudflare DNS challenge.

- **FRITZ!Box:** *Internet › Permit Access › Port Sharing › Add Device for Sharing* › pick the server
  › *New Sharing* › *Port sharing*, application "HTTPS-Server", port 443 to 443, IPv4. Apply.
- **Vodafone Station / other routers:** look for *Port forwarding* or *NAT*, rule TCP 443 → 192.168.0.232:443.
- Give the server a **fixed address** in the router (DHCP reservation), or the forward breaks one day.

### 3. Keep other apps home-only (NPM access list)

Port 443 reaches NPM, and NPM serves every hostname it knows. Without this step, someone who
guesses `casaos.<your-domain>` could reach the CasaOS dashboard from the internet.

1. NPM admin (`http://192.168.0.232:81`) › **Access Lists** › *Add Access List*, name `Home only`.
2. Tab *Access*: `allow 192.168.0.0/24`, `allow 100.64.0.0/10` (Tailscale), then `deny all`. Save.
3. Open **every proxy host except AnyCast** › *Details* › *Access List* › `Home only`. Save.
4. The AnyCast proxy host keeps *Publicly Accessible*.

### 4. DNS: point `anycast` at your home IP

In Cloudflare › DNS:

1. Add an **A** record: name `anycast`, IPv4 = your public IP from step 1, **Proxy status: DNS only**
   (grey cloud). A specific record wins over the wildcard `*`, which keeps pointing at Tailscale
   for everything else.
2. Most home IPs change now and then. Install a DDNS updater on the server so the record follows:
   CasaOS › App Store › *Custom Install* with image `favonia/cloudflare-ddns:1`, environment
   `CLOUDFLARE_API_TOKEN=<token with Zone › DNS › Edit for your domain>`, `DOMAINS=anycast.<your-domain>`,
   `PROXIED=false`, `IP6_PROVIDER=none`, network *host*. The same token as NPM's DNS challenge works.

At home, `anycast.<your-domain>` now goes out to the public IP and back in. Most routers handle that
("NAT loopback"; FRITZ!Box does). If yours doesn't, use the LAN name (`tv.<your-domain>`) at home.

### 5. AnyCast settings

1. `.env` (or the CasaOS app's settings) needs `TRUST_PROXY=true`. That trusts exactly one proxy
   (NPM), so AnyCast sees the real address of each visitor and nobody can fake a home address.
2. Update AnyCast, sign in at home, open **Settings › Security**. It should say *connected from
   your home network (192.168.0.x)*. If it shows `172.x` for every device, NPM isn't passing the
   address on: check `TRUST_PROXY` and that NPM forwards to the server's LAN IP.
3. On mobile data with Tailscale off, open `https://anycast.<your-domain>` and try the password:
   AnyCast switches to the code view. Approve it from a device at home to check the whole way.

### 6. A TV

On the TV choose **Sign in with your phone** (TVs start there). Scan the QR code with your phone, or
enter the code in *Settings › Security › Sign in a TV*, and tap **Sign it in**. The TV stays signed
in for 90 days of not being used.

## No phone at hand

Any device that is signed in can approve a code: a PC at home, a tablet. Signing in with a password
works at home and over Tailscale as before.

## Closing the port forward again

Delete the port forward in the router and the `anycast` A record in Cloudflare. Nothing in AnyCast
needs changing.
