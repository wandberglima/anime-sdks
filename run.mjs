import dns from 'node:dns';
import https from 'node:https';
import {
  HttpClient,
  CurlFallbackTransport,
  startServer,
  GogoanimeProvider,
  GoyabuProvider,
  AllmangaProvider,
  AnimeParadiseProvider,
  AnikotoProvider,
  MegaPlayProvider,
  MangadexProvider,
  WeebcentralProvider,
  MangapillProvider,
  AnilistMeta,
  MalMeta,
  KitsuMeta,
} from './dist/index.js';

const DEB = (m) => (process.env.DEBUG ? console.log('[rotator]', m) : undefined);

const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
];

const LANG_POOL = [
  'pt-BR,pt;q=0.9,en-US,en;q=0.7',
  'en-US,en;q=0.9,pt-BR;q=0.8',
  'en-US,en;q=0.9',
  'pt-PT,pt;q=0.9,en-US,en;q=0.7',
  'es-ES,es;q=0.9,en-US,en;q=0.7',
];

const SEC_CH_UA_POOL = [
  '"Chromium";v="126", "Google Chrome";v="126", "Not/A)Brand";v="99"',
  '"Chromium";v="125", "Google Chrome";v="125", "Not/A)Brand";v="24"',
  '"Chromium";v="127", "Google Chrome";v="127", "Not/A)Brand";v="8"',
  '"Not_A Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
];

const PN_POOL = ['"Windows"', '"macOS"', '"Linux"', '"Android"'];

const DNS_RESOLVERS = [
  ['8.8.8.8', '8.8.4.4'],
  ['1.1.1.1', '1.0.0.1'],
  ['9.9.9.9', '149.112.112.112'],
  ['208.67.222.222', '208.67.220.220'],
  ['94.140.14.14', '94.140.15.15'],
  ['1.1.1.2', '1.0.0.2'],
];

const aleatorio = (lista) => lista[Math.floor(Math.random() * lista.length)];

function cabecalhosRotativos(base = {}) {
  const headers = { ...base };
  headers['User-Agent'] = aleatorio(UA_POOL);
  headers['Accept-Language'] = aleatorio(LANG_POOL);
  headers['sec-ch-ua'] = aleatorio(SEC_CH_UA_POOL);
  headers['sec-ch-ua-mobile'] = '?0';
  headers['sec-ch-ua-platform'] = aleatorio(PN_POOL);
  headers['Sec-Fetch-Dest'] = aleatorio(['document', 'empty', 'video']);
  headers['Sec-Fetch-Mode'] = aleatorio(['navigate', 'cors', 'no-cors']);
  headers['Sec-Fetch-Site'] = 'same-origin';
  headers['Upgrade-Insecure-Requests'] = '1';
  if (!headers['Accept'])
    headers['Accept'] =
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
  return headers;
}

async function resolverDnsAleatorio(hostname) {
  const servers = aleatorio(DNS_RESOLVERS);
  const r = new dns.promises.Resolver();
  r.setServers(servers);
  return new Promise((resolveFinal) => {
    const timer = setTimeout(() => {
      try {
        r.cancel();
      } catch {}
      resolveFinal(null);
    }, 3500);
    r.resolve4(hostname)
      .then((addrs) => {
        clearTimeout(timer);
        resolveFinal(
          addrs && addrs.length ? addrs[Math.floor(Math.random() * addrs.length)] : null,
        );
      })
      .catch(() => {
        clearTimeout(timer);
        resolveFinal(null);
      });
  });
}

function respostaComposta(bloco, urlFinal) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(bloco.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.append(k, String(v));
  }
  const status = bloco.status || 200;
  return Object.assign(
    new Response(new Uint8Array(bloco.buf), {
      status,
      statusText: status === 200 ? 'OK' : 'HTTP',
      headers,
    }),
    { url: urlFinal },
  );
}

async function requisicaoDireta(parts, init, redirectsRestantes) {
  const url = new URL(parts.ipUrl);
  const body =
    typeof init.body === 'string'
      ? init.body
      : init.body instanceof Uint8Array
        ? Buffer.from(init.body)
        : undefined;
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: url.hostname,
        port: 443,
        path: url.pathname + url.search,
        method: init.method || 'GET',
        headers: { ...(init.headers || {}), Host: parts.host, Referer: parts.base },
        servername: parts.sni,
        rejectUnauthorized: true,
        timeout: 20000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const code = res.statusCode || 200;
          if (
            [301, 302, 303, 307, 308].includes(code) &&
            res.headers.location &&
            redirectsRestantes > 0
          ) {
            const alvoBase = new URL(parts.base);
            const novoUrl = new URL(res.headers.location, alvoBase).href;
            DEB(`redirect ${code} -> ${novoUrl}`);
            resolverIpENovo(novoUrl, init.method, redirectsRestantes - 1, init.headers || {})
              .then(resolve)
              .catch(reject);
            return;
          }
          resolve(respostaComposta({ status: code, headers: res.headers, buf }, parts.base));
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout direto')));
    if (body) req.write(body);
    req.end();
    if (init.signal) {
      init.signal.addEventListener('abort', () => req.destroy(new Error('abortado')));
    }
  });
}

async function resolverIpENovo(urlStr, metodo, redirectsRestantes, headers) {
  const url = new URL(urlStr);
  if (url.protocol !== 'https:') {
    throw new Error('nao-https');
  }
  const ip = await resolverDnsAleatorio(url.hostname);
  if (!ip) {
    throw new Error(`dns-falhou: ${url.hostname}`);
  }
  const copia = new URL(url.href);
  copia.hostname = ip;
  DEB(`${url.hostname} -> ${ip}`);
  return requisicaoDireta(
    { ipUrl: copia.href, host: url.host, sni: url.hostname, base: url.href },
    { method: metodo, headers, signal: undefined, body: undefined },
    4,
  );
}

class TransporteRotativo {
  constructor(base) {
    this.base = base;
  }

  async fetch(urlStr, init) {
    const headers = cabecalhosRotativos(init.headers || {});
    try {
      if (!process.env.PROXY_URL && urlStr.startsWith('https://')) {
        const viaIp = await resolverIpENovo(urlStr, init.method || 'GET', 4, headers);
        DEB('OK via DNS aleatorio');
        return viaIp;
      }
      return this.base.fetch(urlStr, { ...init, headers });
    } catch (e) {
      DEB(`fallback (${e?.message})`);
      return this.base.fetch(urlStr, { ...init, headers });
    }
  }
}

const http = new HttpClient({
  timeoutMs: 30000,
  proxyUrl: process.env.PROXY_URL,
  proxyType: process.env.PROXY_TYPE === 'query' ? 'query' : 'prepend',
  proxyQueryParam: 'url',
  transport: new TransporteRotativo(new CurlFallbackTransport({ timeoutMs: 30000 })),
});

const store = new Map();
const cache = {
  get: (key) => store.get(key),
  set: (key, value) => store.set(key, value),
};

const port = Number(process.env.PORT ?? 3001);

startServer({
  providers: [
    new GogoanimeProvider(http),
    new GoyabuProvider(http),
    new AllmangaProvider(http),
    new AnimeParadiseProvider(http),
    new AnikotoProvider(http),
    new MegaPlayProvider(http),
    new MangadexProvider(http),
    new WeebcentralProvider(http),
    new MangapillProvider(http),
  ],
  metaProviders: [new AnilistMeta(http), new MalMeta(http), new KitsuMeta(http)],
  port,
  proxy: false,
  cache,
});
