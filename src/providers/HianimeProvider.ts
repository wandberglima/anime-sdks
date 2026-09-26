import { BaseProvider, CallOptions } from './BaseProvider.js';
import { HttpClient } from '../transport/http.js';
import {
  IMediaSearchResult,
  IContentUnit,
  ResolvedMediaStream,
  MediaCatalogType,
} from '../types/index.js';
import { normalizeSubtitleEntries } from '../utils/subtitles.js';

/**
 * Consumet-compatible coverage of HiAnime (formerly Zoro).
 *
 * Uses a public consumet-api instance that proxies HiAnime's catalogue and
 * watch endpoints to JSON. The instance is configurable (`apiBase`, env
 * `CONSUMET_API_URL`) because public instances come and go — when this one
 * is blocked/quarantined, swap the env to another instance without touching
 * code.
 */
const DEFAULT_API = 'https://anime-api.hxsh.xyz';

export class HianimeProvider extends BaseProvider {
  public readonly id = 'hianime';
  public readonly supportedTypes: MediaCatalogType[] = ['ANIME'];

  public static readonly malsyncSites: readonly string[] = ['HiAnime', 'Zoro'];

  private readonly apiBase: string;

  constructor(http: HttpClient, options: { apiBase?: string } = {}) {
    super(http);
    this.apiBase = (options.apiBase ?? process.env.CONSUMET_API_URL ?? DEFAULT_API).replace(
      /\/+$/,
      '',
    );
  }

  protected async searchRaw(
    query: string,
    options: CallOptions = {},
  ): Promise<IMediaSearchResult[]> {
    const res = await this.http.get(
      `${this.apiBase}/search/hianime/${encodeURIComponent(query)}?page=1`,
      {
        signal: options.signal,
        headers: { Accept: 'application/json' },
      },
    );
    if (res.status !== 200) {
      throw new Error(`Hianime: search falhou com status ${res.status}`);
    }
    const json = (await res.json()) as any;
    const results: any[] = Array.isArray(json?.results) ? json.results : [];
    return results.map((item) => ({
      id: String(item.id ?? item.animeId ?? ''),
      title: item.title ?? '',
      thumbnailUrl: item.image,
      catalogType: 'ANIME' as const,
      providerId: this.id,
      availableLanguages: parseSubOrDub(item.subOrDub),
      year: yearFromReleaseDate(item.releaseDate),
    }));
  }

  protected async fetchContentUnitsRaw(
    mediaId: string,
    options: CallOptions = {},
  ): Promise<IContentUnit[]> {
    const res = await this.http.get(
      `${this.apiBase}/anime/hianime/episodes/${encodeURIComponent(mediaId)}`,
      {
        signal: options.signal,
        headers: { Accept: 'application/json' },
      },
    );
    if (res.status !== 200) {
      throw new Error(`Hianime: episódios falharam com status ${res.status}`);
    }
    const json = (await res.json()) as any;
    const episodes: any[] = Array.isArray(json?.data?.episodes) ? json.data.episodes : [];
    return episodes.map((ep) => ({
      id: String(ep.id ?? `${mediaId}?ep=${ep.number}`),
      title: ep.title ?? `Episódio ${ep.number}`,
      number: Number(ep.number),
      availableLanguages: ['sub'] as const,
      isFiller: Boolean(ep.isFiller),
      thumbnailUrl: ep.image,
    }));
  }

  protected async resolveStreamRaw(
    unitId: string,
    _language?: import('../types/index.js').ContentLanguage,
    options: CallOptions = {},
  ): Promise<ResolvedMediaStream> {
    const url = `${this.apiBase}/anime/hianime/watch?id=${encodeURIComponent(unitId)}`;
    const res = await this.http.get(url, {
      signal: options.signal,
      headers: { Accept: 'application/json', Referer: 'https://hianime.to/' },
    });
    if (res.status !== 200) {
      throw new Error(`Hianime: watch falhou com status ${res.status}`);
    }
    const json = (await res.json()) as any;
    const sources: any[] = Array.isArray(json?.sources) ? json.sources : [];
    if (sources.length === 0) {
      throw new Error('Hianime: nenhuma fonte de stream retornada');
    }
    const best = sources.find((s) => Boolean(s.isM3U8)) ?? sources[0];
    const subtitles = normalizeSubtitleEntries(json?.subtitles);
    const headers = isNonEmptyObject(json?.headers)
      ? json.headers
      : { Referer: 'https://hianime.to/' };
    return {
      type: 'video',
      streams: [
        {
          sourceUrl: String(best.url),
          isHLS: Boolean(best.isM3U8) || String(best.url).includes('.m3u8'),
          quality: best.quality ?? 'auto',
          language: 'sub',
          headers,
          ...(subtitles.length > 0 ? { subtitles } : {}),
        },
      ],
    };
  }
}

function parseSubOrDub(value: unknown): Array<'sub' | 'dub'> {
  const raw = String(value ?? '').toLowerCase();
  const out: Array<'sub' | 'dub'> = [];
  if (raw.includes('sub')) out.push('sub');
  if (raw.includes('dub')) out.push('dub');
  return out.length > 0 ? out : ['sub'];
}

function yearFromReleaseDate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const year = Number(value.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : undefined;
}

function isNonEmptyObject(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}
