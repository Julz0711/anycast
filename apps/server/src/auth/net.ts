/** Whether a client address is the home network (LAN, Tailscale, this machine) or the internet. */
import { isIP } from 'node:net';

const V4_PRIVATE: [number, number][] = [
  [0x0a000000, 8], // 10.0.0.0/8
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16], // 192.168.0.0/16
  [0x64400000, 10], // 100.64.0.0/10: carrier-grade NAT, which Tailscale uses
  [0x7f000000, 8], // 127.0.0.0/8
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local
];

function v4(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** True for private, Tailscale, loopback and link-local addresses (IPv4, IPv6 and IPv4-mapped IPv6). */
export function isHomeAddress(ip: string | undefined | null): boolean {
  if (!ip) return false;
  let a = ip.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1]!;
  const kind = isIP(a);
  if (kind === 4) {
    const n = v4(a)!;
    return V4_PRIVATE.some(([net, bits]) => (n >>> (32 - bits)) === (net >>> (32 - bits)));
  }
  if (kind === 6) {
    if (a === '::1') return true;
    const first = parseInt(a.split(':')[0] || '0', 16);
    // fc00::/7 unique local (Tailscale uses fd7a:115c:a1e0::/48), fe80::/10 link-local
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  return false;
}
