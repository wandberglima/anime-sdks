import http from 'node:http';
import {
  AnimeParadiseProvider,
  AnikotoProvider,
  GogoanimeProvider,
  GoyabuProvider,
  MegaPlayProvider,
  HianimeProvider,
  AllmangaProvider,
  MangadexProvider,
  WeebcentralProvider,
  MangapillProvider,
  AnilistMeta,
  MalMeta,
  KitsuMeta,
  MappingClient,
  startServer,
  HttpClient,
  FetchTransport,
} from '../dist/index.js';

export const config = { maxDuration: 60 };

const cacheStore = new Map<string, unknown>();
const cache = {
  get: async (key: string) => cacheStore.get(key),
  set: async (key: string, value: unknown) => {
    cacheStore.set(key, value);
  },
};

let portPromise: Promise<number> | null = null;

class RetryTransport {
  constructor(private base: { fetch(url: string, init?: unknown): Promise<unknown> }) {}

  async fetch(url: string, init?: unknown): Promise<unknown> {
    let ultimoErro: unknown;
    for (let tentativa = 0; tentativa < 4; tentativa++) {
      try {
        const res = (await this.base.fetch(url, init)) as { status?: number } | null;
        if (res && res.status !== undefined && ![502, 503].includes(res.status)) {
          return res;
        }
      } catch (e) {
        ultimoErro = e;
      }
    }
    if (ultimoErro) throw ultimoErro;
    return this.base.fetch(url, init);
  }
}

function internalServer(): Promise<number> {
  portPromise ??= new Promise<number>((resolve, reject) => {
    try {
      const httpClient = new HttpClient({
        timeoutMs: 30000,
        transport: new RetryTransport(new FetchTransport()),
      });
      const mapping = new MappingClient(httpClient, {
        disableAnify: true,
        disableArmServer: true,
      });
      const server = startServer({
        providers: [
          new GogoanimeProvider(httpClient),
          new GoyabuProvider(httpClient),
          new AllmangaProvider(httpClient),
          new AnimeParadiseProvider(httpClient),
          new AnikotoProvider(httpClient),
          new MegaPlayProvider(httpClient),
          new HianimeProvider(httpClient),
          new MangadexProvider(httpClient),
          new WeebcentralProvider(httpClient),
          new MangapillProvider(httpClient),
        ],
        metaProviders: [
          new AnilistMeta(httpClient, { mappingClient: mapping }),
          new MalMeta(httpClient, { mappingClient: mapping }),
          new KitsuMeta(httpClient, { mappingClient: mapping }),
        ],
        port: 0,
        proxy: false,
        cache,
        ...(process.env.ANIME_SDK_AUTH ? { auth: { token: process.env.ANIME_SDK_AUTH } } : {}),
      });
      server.once('error', reject);
      server.once('listening', () => {
        const addr = server.address() as import('node:net').AddressInfo;
        resolve(addr.port);
      });
    } catch (e) {
      reject(e);
    }
  });
  return portPromise;
}

export default async function handler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const port = await internalServer();
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      headers[k] = v as string | string[];
    }
    headers['host'] = `127.0.0.1:${port}`;
    const proxy = http.request(
      { host: '127.0.0.1', port, path: req.url ?? '/', method: req.method, headers },
      (up) => {
        res.statusCode = up.statusCode ?? 200;
        for (const [k, v] of Object.entries(up.headers)) {
          if (v === undefined) continue;
          res.setHeader(k, v);
        }
        up.pipe(res);
      },
    );
    proxy.on('error', () => {
      if (!res.writableEnded) {
        res.statusCode = 502;
        res.end('Bad Gateway');
      }
    });
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      proxy.end();
    } else {
      req.pipe(proxy);
    }
  } catch (e) {
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  }
}
