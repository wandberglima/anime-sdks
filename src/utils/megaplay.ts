import { createDecipheriv } from 'node:crypto';

const AES_KEY_SEED = 'i?LMTAx0Q6,:}50U';
const AES_IV = "W0;27ToaUpl_P%'c";

function decryptBase64UrlToken(token: string): string {
  const key = Buffer.concat([Buffer.from(AES_KEY_SEED, 'utf8')], 32);
  const iv = Buffer.from(AES_IV, 'utf8');
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/');
  const cipher = createDecipheriv('aes-256-cbc', key, iv);
  const plain = Buffer.concat([cipher.update(Buffer.from(b64, 'base64')), cipher.final()]);
  return plain.toString('utf8');
}

export type MegaPlaySourcesJson = {
  sources?: { file?: string } | { file?: string }[];
  enc?: string;
};

export function megaPlaySourceUrl(
  sourcesJson: MegaPlaySourcesJson | null | undefined,
): string | null {
  if (!sourcesJson) return null;
  const sources = sourcesJson.sources as { file?: string } | { file?: string }[] | undefined;
  if (sources && typeof (sources as { file?: string }).file === 'string') {
    return (sources as { file?: string }).file as string;
  }
  if (Array.isArray(sources) && sources[0] && typeof sources[0].file === 'string') {
    return sources[0].file as string;
  }
  if (typeof sourcesJson.enc === 'string' && sourcesJson.enc.length > 0) {
    try {
      const raw = decryptBase64UrlToken(sourcesJson.enc).trim();
      try {
        const parsed = JSON.parse(raw) as { file?: string };
        if (parsed && typeof parsed.file === 'string') return parsed.file;
      } catch {
        // raw text source
      }
      return raw;
    } catch {
      return null;
    }
  }
  return null;
}
