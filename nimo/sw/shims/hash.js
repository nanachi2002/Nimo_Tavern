import { sha256 as s256 } from '@noble/hashes/sha256';
import { sha512 as s512 } from '@noble/hashes/sha512';
import { sha1 as s1, md5 as m5 } from '@noble/hashes/legacy';
export const sha256 = (d) => s256(d);
export const sha512 = (d) => s512(d);
export const sha1 = (d) => s1(d);
export const md5 = (d) => m5(d);
