import { BaseProvider, CallOptions } from './BaseProvider.js';
import { HttpClient } from '../transport/http.js';
import {
  MKISSA_BUILD_ID,
  MKISSA_CONTENT_LANE,
  MKISSA_EPISODE_QUERY_HASH,
  MKISSA_STATIC_BOOT,
  MkissaBootstrap,
  buildAaReq,
  decryptTobeparsed,
  deriveKey,
} from '../utils/allanimeCrypto.js';
import { Mp4UploadExtractor } from '../extractors/Mp4UploadExtractor.js';
import { GenericHlsExtractor } from '../extractors/GenericHlsExtractor.js';
import {
  IMediaSearchResult,
  IContentUnit,
  ResolvedMediaStream,
  MediaCatalogType,
  IVideoPayload,
  ContentLanguage,
} from '../types/index.js';

export interface AllmangaOptions {
  baseUrl?: string;
  /** Bootstrap origin (defaults to https://api.mkissa.net). */
  origin?: string;
  /** Static `x-aa-boot` token; defaults to the build-181 constant. */
  bootToken?: string;
  /** Default language to use if not specified per-call. Defaults to 'sub'. */
  defaultLanguage?: ContentLanguage;
}

/**
 * Decode an AllAnime obfuscated source URL.
 *
 * AllAnime prefixes obfuscated URLs with `--` followed by a hex string. Each
 * pair of hex digits is XOR'd with 0x38 to recover the original byte. After
 * decoding, the path `/clock` is rewritten to `/clock.json`.
 */
function decodeAllAnimeSource(encoded: string): string {
  const hex = encoded.startsWith('--') ? encoded.slice(2) : encoded;
  const bytes = new Uint8Array(hex.length >>> 1);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i >>> 1] = parseInt(hex.substring(i, i + 2), 16) ^ 0x38;
  }
  // latin1 preserves the raw byte values for non-ASCII characters
  const decoded = new TextDecoder('latin1').decode(bytes);
  return decoded.replace(/\/clock(?=\?|$)/, '/clock.json');
}

const MKISSA_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';

/**
 * AllAnime / mkissa provider.
 *
 * The mkissa backend (`api.mkissa.net`) protects its `episode` resolver with a
 * signed `aaReq` header (see `utils/allanimeCrypto.ts`). Public queries
 * (`shows`, `show`) work with just `x-build-id`; the episode resolver needs a
 * bootstrap key + signed token.
 *
 * The backend additionally enforces Cloudflare Turnstile anti-abuse on flagged
 * clients. When that triggers, responses carry `AA_CRYPTO_STALE` /
 * `NEED_CAPTCHA`; those are surfaced as-is so the router can fall back to
 * another provider.
 */
export class AllmangaProvider extends BaseProvider {
  public readonly id = 'allmanga';
  public readonly supportedTypes: MediaCatalogType[] = ['ANIME'];

  private apiBase: string;
  private apiHost: string;
  private referer: string;
  private origin: string;
  private bootToken: string;
  private defaultLanguage: ContentLanguage;

  private bootstrapCache: MkissaBootstrap | null = null;
  private bootstrapAt = 0;

  private mp4UploadExtractor: Mp4UploadExtractor;
  private genericExtractor: GenericHlsExtractor;

  constructor(http: HttpClient, options: AllmangaOptions = {}) {
    super(http);
    const base = options.baseUrl ?? 'https://api.mkissa.net/api';
    this.apiBase = base;
    this.apiHost = options.origin ?? base.replace(/\/api\/?$/, '');
    this.referer = 'https://mkissa.to/';
    this.origin = 'https://mkissa.to';
    this.bootToken = options.bootToken ?? MKISSA_STATIC_BOOT;
    this.defaultLanguage = options.defaultLanguage ?? 'sub';
    this.mp4UploadExtractor = new Mp4UploadExtractor(this.http);
    this.genericExtractor = new GenericHlsExtractor(this.http);
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  protected async searchRaw(
    query: string,
    options: CallOptions = {},
  ): Promise<IMediaSearchResult[]> {
    const searchGql = `query($search: SearchInput, $limit: Int, $page: Int, $countryOrigin: VaildCountryOriginEnumType) {
      shows(search: $search, limit: $limit, page: $page, countryOrigin: $countryOrigin) {
        edges { _id name englishName availableEpisodes __typename }
      }
    }`;

    const variables = {
      search: { allowAdult: false, allowUnknown: false, query },
      limit: 40,
      page: 1,
      countryOrigin: 'ALL',
    };

    const res = await this.http.post(
      this.apiBase,
      { variables, query: searchGql },
      { headers: this.apiHeaders(), signal: options.signal },
    );

    if (res.status !== 200) {
      throw new Error(`AllManga search failed with status ${res.status}`);
    }

    const json = (await res.json()) as any;
    this.throwIfAntiAbuse(json);
    const edges = json?.data?.shows?.edges ?? [];
    const out: IMediaSearchResult[] = [];

    for (const edge of edges) {
      const title = edge.englishName || edge.name;
      if (!title) continue;
      const avail = edge.availableEpisodes as Record<string, number> | undefined;
      const langs: ContentLanguage[] = [];
      if (avail?.sub) langs.push('sub');
      if (avail?.dub) langs.push('dub');
      if (avail?.raw) langs.push('raw');
      out.push({
        id: edge._id,
        title,
        catalogType: 'ANIME',
        providerId: this.id,
        availableLanguages: langs.length > 0 ? langs : undefined,
      });
    }
    return out;
  }

  // ─── Episodes ──────────────────────────────────────────────────────────────

  protected async fetchContentUnitsRaw(
    mediaId: string,
    options: CallOptions = {},
  ): Promise<IContentUnit[]> {
    const gql = `query ($showId: String!) { show( _id: $showId ) { _id availableEpisodesDetail }}`;

    const res = await this.http.post(
      this.apiBase,
      { variables: { showId: mediaId }, query: gql },
      { headers: this.apiHeaders(), signal: options.signal },
    );
    if (res.status !== 200) {
      throw new Error(`Failed to fetch AllManga episodes: ${res.status}`);
    }

    const json = (await res.json()) as any;
    this.throwIfAntiAbuse(json);
    const detail = json?.data?.show?.availableEpisodesDetail ?? {};

    // Merge sub/dub/raw episode lists into one canonical list keyed by episode
    // number; each unit advertises which translations include it.
    const merged = new Map<string, { num: number; langs: ContentLanguage[] }>();
    for (const lang of ['sub', 'dub', 'raw'] as const) {
      const list: string[] = Array.isArray(detail[lang]) ? detail[lang] : [];
      for (const epStr of list) {
        const num = parseFloat(epStr);
        if (isNaN(num)) continue;
        const entry = merged.get(epStr) ?? { num, langs: [] };
        if (!entry.langs.includes(lang)) entry.langs.push(lang);
        merged.set(epStr, entry);
      }
    }

    const units: IContentUnit[] = [];
    for (const [epStr, { num, langs }] of merged) {
      units.push({
        id: `${mediaId}/${epStr}`,
        title: `Episode ${epStr}`,
        number: num,
        availableLanguages: langs,
      });
    }
    return units.sort((a, b) => a.number - b.number);
  }

  // ─── Streams ───────────────────────────────────────────────────────────────

  protected async resolveStreamRaw(
    unitId: string,
    language?: ContentLanguage,
    options: CallOptions = {},
  ): Promise<ResolvedMediaStream> {
    // Accept both the new `${showId}/${episodeString}` shape and the legacy
    // `${showId}/${episodeString}/${lang}` shape so older client links keep
    // working until they're refreshed.
    const [showId, episodeString, legacyLang] = unitId.split('/');
    if (!showId || !episodeString) {
      throw new Error(`Invalid AllManga unit ID: ${unitId}`);
    }
    const lang = language ?? (legacyLang as ContentLanguage | undefined) ?? this.defaultLanguage;

    const sources = await this.fetchEpisodeSources(showId, episodeString, lang, options.signal);
    if (sources.length === 0) {
      throw new Error(`AllManga returned no source URLs for ${unitId} (lang=${lang})`);
    }

    // Process sources in priority order; collect streams across all sources.
    sources.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));

    const streams: IVideoPayload[] = [];
    const errors: string[] = [];

    for (const src of sources) {
      try {
        const extracted = await this.extractSource(src, lang);
        streams.push(...extracted);
      } catch (e) {
        errors.push(`${src.sourceName}: ${(e as Error).message}`);
      }
    }

    if (streams.length === 0) {
      throw new Error(
        `AllManga: no playable streams could be extracted for ${unitId}. ` +
          `Tried ${sources.length} source(s). Errors: ${errors.join('; ')}`,
      );
    }

    // Rank: direct m3u8/mp4 ahead of anything else.
    streams.sort((a, b) => qualityScore(b) - qualityScore(a));

    return { type: 'video', streams };
  }

  // ─── Crypto / bootstrap ─────────────────────────────────────────────────────

  private apiHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Referer: this.referer,
      Origin: this.origin,
      'User-Agent': MKISSA_USER_AGENT,
    };
  }

  private graphqlHeaders(): Record<string, string> {
    return {
      Referer: this.referer,
      Origin: this.origin,
      'User-Agent': MKISSA_USER_AGENT,
      'x-build-id': MKISSA_BUILD_ID,
    };
  }

  /**
   * Fetch (and cache) the epoch bootstrap. `x-aa-boot` is required and is a
   * static build-181 token; the response carries the `partB` used to derive
   * the AES key.
   */
  private async fetchBootstrap(signal?: AbortSignal): Promise<MkissaBootstrap> {
    const fresh = this.bootstrapCache && Date.now() - this.bootstrapAt < 4 * 60 * 1000;
    if (fresh) return this.bootstrapCache!;

    const url = `${this.apiHost}/client-crypto/v1/bootstrap?buildId=${MKISSA_BUILD_ID}&k=${MKISSA_CONTENT_LANE}`;
    const res = await this.http.get(url, {
      headers: {
        Referer: this.referer,
        Origin: this.origin,
        'User-Agent': MKISSA_USER_AGENT,
        'x-build-id': MKISSA_BUILD_ID,
        'x-aa-boot': this.bootToken,
      },
      signal,
    });
    if (res.status !== 200) {
      throw new Error(
        `AllManga crypto bootstrap failed (${res.status}). The static boot token may have rotated.`,
      );
    }
    const body = (await res.json()) as MkissaBootstrap;
    if (!body?.partB) throw new Error('AllManga crypto bootstrap returned no partB');
    this.bootstrapCache = body;
    this.bootstrapAt = Date.now();
    return body;
  }

  private async fetchEpisodeSources(
    showId: string,
    episodeString: string,
    lang: ContentLanguage,
    signal?: AbortSignal,
  ): Promise<Array<{ sourceUrl: string; sourceName?: string; priority?: number }>> {
    const variables = { showId, translationType: lang, episodeString };

    // Retry once on AA_CRYPTO_STALE (the site itself re-bootstraps after one).
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) this.bootstrapCache = null;

      const bootstrap = await this.fetchBootstrap(signal);
      const key = deriveKey(bootstrap);
      const aaReq = await buildAaReq(key, bootstrap.epoch, MKISSA_EPISODE_QUERY_HASH);

      const extensions = {
        persistedQuery: { version: 1, sha256Hash: MKISSA_EPISODE_QUERY_HASH },
        k: MKISSA_CONTENT_LANE,
        aaReq,
      };

      const url = `${this.apiBase}?variables=${encodeURIComponent(
        JSON.stringify(variables),
      )}&extensions=${encodeURIComponent(JSON.stringify(extensions))}`;

      const res = await this.http.get(url, { headers: this.graphqlHeaders(), signal });
      if (res.status !== 200) {
        throw new Error(`Failed to load AllManga stream sources: ${res.status}`);
      }
      const json = (await res.json()) as any;

      const code = json?.errors?.[0]?.extensions?.code ?? json?.errors?.[0]?.message;
      if (code === 'AA_CRYPTO_STALE' && attempt === 0) {
        continue;
      }
      this.throwIfAntiAbuse(json);

      const tobeparsed: string | undefined = json?.data?.tobeparsed;
      if (tobeparsed) {
        return this.parseTobeparsed(key, tobeparsed);
      }

      // Non-encrypted shape (older builds): sourceUrls directly.
      const direct = json?.data?.episode?.sourceUrls;
      if (Array.isArray(direct)) return direct;
    }

    throw new Error('AllManga episode request did not return sources after retry');
  }

  private async parseTobeparsed(
    key: Uint8Array,
    blob: string,
  ): Promise<Array<{ sourceUrl: string; sourceName?: string; priority?: number }>> {
    const text = await decryptTobeparsed(key, blob);
    const parsed = JSON.parse(text);
    const sources = parsed?.episode?.sourceUrls ?? parsed?.data?.episode?.sourceUrls ?? null;
    if (!Array.isArray(sources)) {
      throw new Error('No sourceUrls in decrypted tobeparsed payload');
    }
    return sources;
  }

  /**
   * The backend signals anti-abuse as a GraphQL error (`NEED_CAPTCHA`,
   * `AA_CRYPTO_MISSING`, …). Bubble those up verbatim so the router can
   * fall back instead of reporting a generic failure.
   */
  private throwIfAntiAbuse(json: any): void {
    const err = json?.errors?.[0];
    if (!err) return;
    const code = err?.extensions?.code ?? err?.message;
    if (typeof code === 'string' && code.startsWith('AA_CRYPTO')) {
      throw new Error(`AllManga blocked by anti-abuse: ${code}`);
    }
    if (
      typeof code === 'string' &&
      (code === 'NEED_CAPTCHA' || String(err.message).includes('NEED_CAPTCHA'))
    ) {
      throw new Error('AllManga requires CAPTCHA (anti-abuse): NEED_CAPTCHA');
    }
  }

  // ─── Source extraction ───────────────────────────────────────────────────────

  private async extractSource(
    src: { sourceUrl: string; sourceName?: string },
    lang: ContentLanguage,
  ): Promise<IVideoPayload[]> {
    let raw = src.sourceUrl;
    if (!raw) return [];

    // XOR-decode obfuscated AllAnime API paths (Luf-Mp4, S-mp4, Default, ...)
    if (raw.startsWith('--')) {
      raw = decodeAllAnimeSource(raw);
      if (raw.startsWith('/')) raw = this.apiHost + raw;
    }
    if (raw.startsWith('//')) raw = 'https:' + raw;

    const headers = {
      Referer: this.referer,
      'User-Agent': MKISSA_USER_AGENT,
    };

    // 1. Internal AllAnime clock.json: returns JSON with `links` array.
    if (raw.includes('/clock.json')) {
      return this.resolveClockJson(raw, lang);
    }

    // 2. Direct media (m3u8 / mp4)
    if (/\.m3u8(?:\?|$)/.test(raw) || /\.mp4(?:\?|$)/.test(raw)) {
      return [
        {
          sourceUrl: raw,
          isHLS: raw.includes('.m3u8'),
          quality: 'auto',
          language: lang,
          headers,
        },
      ];
    }

    // 3. Yt-mp4 alias: tools.fast4speed.rsvp gives direct mp4
    if (raw.includes('tools.fast4speed.rsvp')) {
      return [
        {
          sourceUrl: raw,
          isHLS: false,
          quality: 'auto',
          language: lang,
          headers,
        },
      ];
    }

    // 4. Mp4Upload embed page - extract direct mp4 URL
    if (Mp4UploadExtractor.matches(raw)) {
      return this.mp4UploadExtractor.extract(raw);
    }

    // 5. Best-effort generic HLS/MP4 extraction from embed pages
    //    (handles vibeplayer.site, otakuvid.online, bibiemb.xyz patterns)
    try {
      const extracted = await this.genericExtractor.extract(raw);
      if (extracted.length > 0) {
        return extracted.map((p) => ({ ...p, language: lang }));
      }
    } catch {
      /* fall through */
    }

    // Could not extract; skip this source rather than returning a useless embed URL
    return [];
  }

  private async resolveClockJson(url: string, lang: ContentLanguage): Promise<IVideoPayload[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await this.http.get(url, {
        headers: {
          Referer: this.referer,
          'User-Agent': MKISSA_USER_AGENT,
        },
        signal: controller.signal as any,
      });
      clearTimeout(timer);
      if (res.status !== 200) {
        throw new Error(`clock.json returned ${res.status}`);
      }
      const json = (await res.json()) as any;
      const links = json.links ?? [];
      const out: IVideoPayload[] = [];

      for (const item of links) {
        const link = item.link as string | undefined;
        if (!link) continue;

        // Wixmp packager → expand quality variants
        if (link.includes('repackager.wixmp.com')) {
          const m = link.match(/\/,([^/]+),\/mp4/);
          if (m) {
            const qualities = m[1].split(',');
            const cleanBase = link
              .replace('repackager.wixmp.com/', '')
              .replace(/\.urlset\/master\.m3u8$/, '');
            for (const q of qualities) {
              const streamUrl = cleanBase.replace(`/,${m[1]},/mp4/`, `/${q}/mp4/`);
              out.push({
                sourceUrl: streamUrl,
                isHLS: false,
                quality: mapQuality(q),
                language: lang,
                headers: { Referer: this.referer },
              });
            }
            continue;
          }
          out.push({
            sourceUrl: link,
            isHLS: true,
            quality: 'auto',
            language: lang,
            headers: { Referer: this.referer },
          });
          continue;
        }

        out.push({
          sourceUrl: link,
          isHLS: !!item.hls || link.includes('.m3u8'),
          quality: mapQuality(item.resolutionStr ?? ''),
          language: lang,
          headers: { Referer: this.referer },
        });
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }
}

function mapQuality(label: string): IVideoPayload['quality'] {
  const s = String(label).toLowerCase();
  if (s.includes('1080')) return '1080p';
  if (s.includes('720')) return '720p';
  if (s.includes('480')) return '480p';
  if (s.includes('360')) return '360p';
  return 'auto';
}

function qualityScore(p: IVideoPayload): number {
  let s = 0;
  // Provider-priority: mp4upload direct mp4 → wixstatic mp4 → m3u8 → other.
  if (/\/video\.mp4(?:[?#]|$)/.test(p.sourceUrl)) s += 30;
  if (p.sourceUrl.includes('wixstatic.com')) s += 25;
  if (p.sourceUrl.includes('mp4upload.com')) s += 20;
  if (/\.m3u8(?:[?#]|$)/.test(p.sourceUrl)) s += 15;
  if (/\.mp4(?:[?#]|$)/.test(p.sourceUrl)) s += 10;
  if (p.sourceUrl.includes('okcdn.ru') && p.isHLS) s += 5;
  if (p.quality === '1080p') s += 4;
  else if (p.quality === '720p') s += 3;
  else if (p.quality === '480p') s += 2;
  else if (p.quality === '360p') s += 1;
  return s;
}
