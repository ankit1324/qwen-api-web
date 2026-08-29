import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export interface BaxiaTokens {
  bxUa: string;
  bxUmidToken: string;
  bxV: string;
  cookies: string;
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
].filter((p): p is string => !!p);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const CACHE_TTL = 25 * 60 * 1000;

let cache: BaxiaTokens | null = null;
let cacheTime = 0;

function findChrome(): string | null {
  for (const p of CHROME_CANDIDATES) if (p && fs.existsSync(p)) return p;
  return null;
}

function randomPort(): number {
  return 9400 + Math.floor(Math.random() * 600);
}

function cdpConnect(wsUrl: string): Promise<{ ws: WebSocket; send: (method: string, params?: any) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map<number, { res: (v: any) => void; rej: (e: any) => void }>();
    ws.onopen = () => {
      resolve({
        ws,
        send(method: string, params: any = {}) {
          return new Promise((res, rej) => {
            const msgId = ++id;
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
      });
    };
    ws.onerror = () => reject(new Error('CDP ws error'));
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result);
      }
    };
  });
}

async function getBaxiaTokensFromChrome(): Promise<BaxiaTokens | null> {
  const exe = findChrome();
  if (!exe) return null;
  const port = randomPort();
  const userDataDir = path.join(os.tmpdir(), 'qwen2api-ch-' + process.pid + '-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });
  const proc: ChildProcess = spawn(exe, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-extensions', '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDataDir, '--window-size=1280,800',
    '--user-agent=' + UA, 'about:blank',
  ], { stdio: 'ignore' });

  let result: BaxiaTokens | null = null;
  try {
    let pageWsUrl = '';
    for (let i = 0; i < 40; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const page = Array.isArray(list) ? list.find((t: any) => t.type === 'page') : null;
        if (page && page.webSocketDebuggerUrl) { pageWsUrl = page.webSocketDebuggerUrl; break; }
      } catch { }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!pageWsUrl) throw new Error('Chrome CDP page not reachable');

    const cdp = await cdpConnect(pageWsUrl);
    try {
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Page.navigate', { url: 'https://chat.qwen.ai/' });

      let uid = '', fy = '', cookies = '';
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const ev = await cdp.send('Runtime.evaluate', {
            expression: `(function(){
              var fm = (window.__baxia__||{}).getFYModule;
              if (!fm || !fm.fyObj) return { ready: false };
              var uid='', fy='';
              try { uid = String(fm.getUidToken()); } catch(e) {}
              try { fy = String(fm.getFYToken()); } catch(e) {}
              return { ready: true, uid: uid, fy: fy, cookie: document.cookie || '' };
            })()`,
            returnByValue: true,
          });
          const val = ev && ev.result && ev.result.value;
          if (val && val.ready && typeof val.uid === 'string' && /^T2gA/i.test(val.uid) && val.uid.length > 20) {
            uid = val.uid; fy = val.fy; cookies = val.cookie || '';
            break;
          }
        } catch { }
      }
      if (!uid) throw new Error('Failed to get baxia uid token');
      result = { bxUa: fy || ('231!' + uid), bxUmidToken: uid, bxV: '2.5.37', cookies };
    } finally {
      try { cdp.ws.close(); } catch { }
    }
  } finally {
    try { proc.kill(); } catch { }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { }
  }
  return result;
}

async function getBaxiaTokensFallback(): Promise<BaxiaTokens> {
  const platforms = ['Win32', 'Linux x86_64', 'MacIntel'];
  const languages = ['en-US', 'zh-CN', 'en-GB'];
  const renderers = [
    'ANGLE (Intel, Intel(R) UHD Graphics 630, OpenGL 4.6)',
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1080, OpenGL 4.6)',
    'ANGLE (AMD, AMD Radeon RX 580, OpenGL 4.6)',
  ];
  const canvas = crypto.createHash('sha256').update(crypto.randomBytes(32)).digest('hex');
  const fingerprint = {
    p: platforms[Math.floor(Math.random() * platforms.length)],
    l: languages[Math.floor(Math.random() * languages.length)],
    hc: 4 + Math.floor(Math.random() * 12),
    dm: [4, 8, 16, 32][Math.floor(Math.random() * 4)],
    to: [-480, -300, 0, 60, 480][Math.floor(Math.random() * 5)],
    sw: 1920 + Math.floor(Math.random() * 200),
    sh: 1080 + Math.floor(Math.random() * 100),
    cd: 24,
    pr: [1, 1.25, 1.5, 2][Math.floor(Math.random() * 4)],
    wf: renderers[Math.floor(Math.random() * renderers.length)].substring(0, 20),
    cf: canvas,
    af: (124.04347527516074 + Math.random() * 0.001).toFixed(14),
    ts: Date.now(),
    r: Math.random(),
  };
  const bxUa = '2536!' + Buffer.from(JSON.stringify(fingerprint)).toString('base64');
  let bxUmidToken = '';
  try {
    const resp = await fetch('https://sg-wum.alibaba.com/w/wu.json', {
      headers: { 'User-Agent': UA },
    });
    const bodyText = await resp.text();
    const m = bodyText.match(/umx\.wu\('([^']+)'\)/) || bodyText.match(/'([^']+)'/);
    bxUmidToken = (m && m[1]) || resp.headers.get('etag') || '';
  } catch { }
  if (!bxUmidToken || !/^T2gA/i.test(bxUmidToken)) {
    bxUmidToken = 'T2gA' + crypto.randomBytes(20).toString('base64').replace(/[+/=]/g, '');
  }
  return { bxUa, bxUmidToken, bxV: '2.5.36', cookies: '' };
}

export async function getBaxiaTokens(forceRefresh = false): Promise<BaxiaTokens> {
  const now = Date.now();
  if (!forceRefresh && cache && (now - cacheTime) < CACHE_TTL) {
    return cache;
  }
  let tokens = await getBaxiaTokensFromChrome();
  if (!tokens) {
    tokens = await getBaxiaTokensFallback();
  }
  cache = tokens;
  cacheTime = now;
  return tokens;
}