/**
 * AllAnime / mkissa client-crypto implementation.
 *
 * The mkissa (formerly allanime) GraphQL backend gates the `episode`,
 * `chapterPages` and `music` resolvers behind an AES-256-GCM signed request
 * header (`aaReq`). The scheme, reverse-engineered from the site bundle:
 *
 *   1. Bootstrap:   GET  {origin}/client-crypto/v1/bootstrap?buildId&k
 *                   Requires header `x-aa-boot: <boot token>` and returns
 *                   `{ epoch, partB, k, ... }`.
 *   2. Key:         key = partB XOR MASK  (MASK is a fixed 32-byte constant
 *                   per build). 32-byte AES-256-GCM key.
 *   3. Token:       payload = { v:1, ts, epoch, buildId, qh, k:<lane> }
 *                   ts      = floor(Date.now()/300000)*300000   (5-min bucket)
 *                   iv      = SHA256("<epoch>:<buildId>:<qh>:<ts>:<lane>")[:12]
 *                   out     = base64( \x01 + iv + AES-GCM(key, iv, payload) )
 *   4. Attach:      extensions = { persistedQuery, k:<lane>, aaReq: <token> }
 *
 * `tobeparsed` responses are encrypted with the same key:
 *                   out = base64( \x01 + iv(12) + ct + tag(16) )
 *
 * Note: the backend additionally enforces anti-abuse (Cloudflare Turnstile)
 * on flagged clients, replying `AA_CRYPTO_STALE` / `NEED_CAPTCHA`. Those are
 * surfaced verbatim so callers can degrade gracefully.
 */

export const MKISSA_BUILD_ID = '181';
export const MKISSA_CONTENT_LANE = 'k7';
export const MKISSA_EPISODE_QUERY_HASH =
  'd405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec';

/**
 * Static `x-aa-boot` token accepted by the bootstrap endpoint for build 181.
 * The site generates this dynamically, but for build 181 it is stable across
 * sessions and pages. If the backend rotates it, bootstrap returns 4xx and
 * callers should treat the provider as unavailable.
 */
export const MKISSA_STATIC_BOOT =
  '8aa3b1c1b9b11c6c703e8cdda6e0d9891f84b8d548bcf7593263f2e49d43048c';

/** Fixed 32-byte mask for build 181 (hy('181') in the bundle). */
const MASK_181 = new Uint8Array([
  174, 158, 128, 147, 87, 134, 213, 111, 218, 156, 198, 103, 201, 231, 182, 10, 251, 32, 239, 180,
  254, 193, 84, 193, 189, 77, 152, 250, 6, 74, 167, 60,
]);

/** 5-minute freshness bucket the backend uses for `ts`. */
const TS_BUCKET_MS = 300_000;

const getSubtle = (): SubtleCrypto => {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    return globalThis.crypto.subtle;
  }
  throw new Error('Web Crypto API (subtle) is not available in this environment.');
};

function base64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
  const padded =
    normalized.length % 4 ? normalized + '='.repeat(4 - (normalized.length % 4)) : normalized;
  // Prefer Node's Buffer when available; fall back to atob in browsers.
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(padded, 'base64'));
  }
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export interface MkissaBootstrap {
  epoch: number;
  epochMs?: number;
  graceMs?: number;
  switchAt?: number;
  partB: string;
  k?: string;
}

/**
 * Derive the 32-byte AES-GCM key from a bootstrap `partB` value.
 * `key[i] = partB[i] XOR MASK[i % 32]`.
 */
export function deriveKey(bootstrap: MkissaBootstrap): Uint8Array {
  const partB = base64ToBytes(bootstrap.partB);
  const key = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    key[i] = (partB[i] ?? 0) ^ MASK_181[i % MASK_181.length];
  }
  return key;
}

/**
 * Build the `aaReq` token for a given query hash + content lane.
 * @param key  derived key (see {@link deriveKey})
 * @param epoch bootstrap epoch
 */
export async function buildAaReq(
  key: Uint8Array,
  epoch: number,
  queryHash: string,
  lane: string = MKISSA_CONTENT_LANE,
  buildId: string = MKISSA_BUILD_ID,
): Promise<string> {
  const subtle = getSubtle();
  const ts = Math.floor(Date.now() / TS_BUCKET_MS) * TS_BUCKET_MS;
  const payload = JSON.stringify({ v: 1, ts, epoch, buildId, qh: queryHash, k: lane });

  const ivSource = `${epoch}:${buildId}:${queryHash}:${ts}:${lane}`;
  const ivHash = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(ivSource)));
  const iv = ivHash.subarray(0, 12);

  const cryptoKey = await subtle.importKey('raw', key as any, { name: 'AES-GCM' }, false, [
    'encrypt',
  ]);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, new TextEncoder().encode(payload)),
  );

  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return bytesToBase64(out);
}

/**
 * Decrypt a `tobeparsed` blob: base64( \x01 + iv(12) + ct + tag(16) ).
 * Returns the raw UTF-8 plaintext (expected to be JSON).
 */
export async function decryptTobeparsed(key: Uint8Array, blob: string): Promise<string> {
  const subtle = getSubtle();
  const data = base64ToBytes(blob);
  if (data.length < 30 || data[0] !== 1) {
    throw new Error(`Invalid tobeparsed blob (version=${data[0]}, len=${data.length})`);
  }
  const iv = data.subarray(1, 13);
  const body = data.subarray(13);
  const cryptoKey = await subtle.importKey('raw', key as any, { name: 'AES-GCM' }, false, [
    'decrypt',
  ]);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: iv as any }, cryptoKey, body as any);
  return new TextDecoder().decode(pt);
}

/** Raw loader (used by callers who already hold a key + bootstrap). */
export interface MkissaKeyContext {
  key: Uint8Array;
  epoch: number;
  bootstrap: MkissaBootstrap;
}
