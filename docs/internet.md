# Opening AnyCast to the internet (with two-step sign-in)

Tailscale is still the safest way in. Some devices can't run it, though (a Fire TV Stick on Vega OS,
a hotel TV, a friend's laptop). This guide makes **one** hostname, `anycast.<your-domain>`,
reachable from the whole internet, while everything else on the server (CasaOS, Nginx Proxy
Manager, other apps) stays home-only.

What protects AnyCast then:

- **Two-step sign-in.** A password alone signs in only from the home network or Tailscale. From the
  internet AnyCast also asks for a code from an authenticator app, unless the browser was remembered
  ("Remember this device", 180 days). Until two-step sign-in is on, sign-ins from the internet are
  refused completely (`ANYCAST_2FA_OUTSIDE`, on by default).
- **TVs sign in without typing.** The TV shows a code and a QR code; a phone that is already signed
  in approves it (*Settings › Security › Sign in a TV*, or scan). The approval page shows whether the
  TV is at home or on the internet, so a code someone sent you stands out.
- **Lockouts.** 10 wrong passwords or codes from one address lock that address out for 15 minutes.
  20 from the internet within an hour close the account to the internet for the rest of the hour;
  home and Tailscale can still sign in, so nobody outside can lock you out at home. Five wrong codes
  end a sign-in attempt.
- **Signed-in devices.** *Settings › Security* lists every device with where it was last seen and
  how it signed in. Sign out anything you don't recognize.

## Why a router port and not Cloudflare Tunnel

Cloudflare's proxy and Tunnel are free, but their terms don't allow serving a lot of video through
them, and video is all AnyCast serves. Accounts that do get throttled or blocked. A port forward
sends the video straight from your router, at your own upload speed, with nothing in between. The
DNS record stays **DNS only** (grey cloud); the cost is that your home IP is visible in DNS.

Cloudflare Tunnel is the fallback only if your line has no public IPv4 (step 1).

## 1. Check that your line has a public IPv4

1. In the router's overview, find the **internet / WAN IPv4 address**.
2. On a phone on Wi-Fi, open <https://ifconfig.me> (or search "what is my IP").
3. Same address: port forwarding works. Go on.
   - Router shows `100.64.x.x`–`100.127.x.x`, `10.x`, `192.168.x`, or "DS-Lite": your provider
     shares an IPv4 with other customers, and forwarding can't work. Ask the provider for a public
     IPv4 (many switch it on for free, often called "Dual Stack" or "public IPv4"). Otherwise use
     Cloudflare Tunnel and accept the risk above.

## 2. Forward port 443 to Nginx Proxy Manager

In the router, forward **TCP 443** (external) to **192.168.0.232 port 443** (the server; NPM listens
there). Don't forward 80: the certificate already comes through the Cloudflare DNS challenge.

- **FRITZ!Box:** *Internet › Permit Access › Port Sharing › Add Device for Sharing* › pick the server
  › *New Sharing* › *Port sharing*, application "HTTPS-Server", port 443 to 443, IPv4. Apply.
- **Vodafone Station / other routers:** look for *Port forwarding* or *NAT*, rule TCP 443 → 192.168.0.232:443.
- Give the server a **fixed address** in the router (DHCP reservation), or the forward breaks one day.

## 3. Keep other apps home-only (NPM access list)

Port 443 reaches NPM, and NPM serves every hostname it knows. Without this step, someone who
guesses `casaos.<your-domain>` could reach the CasaOS dashboard from the internet.

1. NPM admin (`http://192.168.0.232:81`) › **Access Lists** › *Add Access List*, name `Home only`.
2. Tab *Access*: `allow 192.168.0.0/24`, `allow 100.64.0.0/10` (Tailscale), then `deny all`. Save.
3. Open **every proxy host except AnyCast** › *Details* › *Access List* › `Home only`. Save.
4. The AnyCast proxy host keeps *Publicly Accessible*.

## 4. DNS: point `anycast` at your home IP

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

## 5. AnyCast settings

1. `.env` (or the CasaOS app's settings) needs `TRUST_PROXY=true`. That trusts exactly one proxy
   (NPM), so AnyCast sees the real address of each visitor and nobody can fake a home address.
2. Update AnyCast, sign in at home, open **Settings › Security**:
   - It should say *connected from your home network (192.168.0.x)*. If it shows `172.x` for every
     device, NPM isn't passing the address on: check `TRUST_PROXY` and that NPM forwards to the
     server's LAN IP.
   - **Two-step sign-in › Set up.** Scan the QR code with an authenticator app (Google
     Authenticator, 1Password, Authy, …), enter the code, and save the recovery codes.
   - Optional: *Signed-in devices › Sign out all others*, so every device signs in once more.
3. On mobile data (Wi-Fi off), open `https://anycast.<your-domain>`: it asks for password and code.

## 6. A TV

On the TV choose **Sign in with your phone** (TVs start there). Scan the QR code with your phone, or
enter the code in *Settings › Security › Sign in a TV*, and tap **Sign it in**. The TV stays signed
in for 90 days of not being used.

## Lost the phone with the authenticator

Sign in with a recovery code ("Lost your phone? Use a recovery code"), then *Settings › Security ›
Turn off* and set it up again on the new phone. No recovery codes left: sign in at home (a password
is enough there) and do the same.

## Turning it off again

Delete the port forward in the router and the `anycast` A record in Cloudflare. Nothing in AnyCast
needs changing.
