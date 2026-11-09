// Outbound network guard shared by the relay and multiplayer AI calls: only public internet addresses.
import dns from 'node:dns/promises';
import net from 'node:net';

// Everything that isn't the public internet: loopback, LAN, link-local, CGNAT, documentation/benchmark ranges,
// multicast, and IPv6 forms that embed or translate IPv4 (mapped, NAT64, 6to4, Teredo).
// Two separate lists: a BlockList also matches IPv4 addresses against IPv6 rules (as ::ffff:a.b.c.d), so the
// "IPv4-mapped" rule below would otherwise block every IPv4 address.
const NON_PUBLIC_V4 = new net.BlockList();
const NON_PUBLIC_V6 = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) NON_PUBLIC_V4.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 96], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) NON_PUBLIC_V6.addSubnet(a, p, 'ipv6');
export function isPublicIp(ip) {
    if (net.isIPv4(ip)) return !NON_PUBLIC_V4.check(ip, 'ipv4');
    if (net.isIPv6(ip)) return !NON_PUBLIC_V6.check(ip, 'ipv6');
    return false;
}

// DNS lookup used for the actual connection. Checking the address here (instead of resolving once
// beforehand) closes DNS rebinding: the socket can only ever connect to an address we've vetted.
export function publicOnlyLookup(hostname, opts, cb) {
    dns.lookup(hostname, { all: true, verbatim: true }).then((addrs) => {
        if (!addrs.length || addrs.some((a) => !isPublicIp(a.address))) return cb(Object.assign(new Error('private address'), { code: 'NIMO_PRIVATE' }));
        if (opts && opts.all) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
    }, (e) => cb(e));
}

