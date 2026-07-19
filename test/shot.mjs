// 画面を見る。node test/shot.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9000 + Math.floor(Math.random() * 900);
const PROFILE = mkdtempSync(join(tmpdir(), 'mole-'));
const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-sandbox', '--disable-gpu', '--window-size=600,600',
  'file://' + join(process.cwd(), 'index.html'),
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise(res => {
  const m = ++id; pending.set(m, res);
  ws.send(JSON.stringify({ id: m, method, params }));
});
const evaluate = async e => (await send('Runtime.evaluate',
  { expression: e, returnByValue: true, awaitPromise: true })).result?.value;

let url;
for (let i = 0; i < 60 && !url; i++) {
  try {
    const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    url = tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
  } catch {}
  if (!url) await sleep(250);
}
ws = new WebSocket(url);
ws.onmessage = e => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } };
await new Promise(r => { ws.onopen = r; });
await send('Runtime.enable');
await sleep(500);

const shot = async name => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`/tmp/${name}.png`, Buffer.from(r.data, 'base64'));
};

await evaluate('__t.pause()');

// キャンバスは 600x600 の窓の中央。画面座標に直してからカーソルを置く。
const box = await evaluate('JSON.stringify(c.getBoundingClientRect())').then(JSON.parse);
const at = (cell, dir) => {
  const D = { up: [0,-1], down: [0,1], left: [-1,0], right: [1,0] }[dir];
  return {                       // 押したい向きの反対側を叩く
    x: box.left + 24 + (cell % 4) * 96 + 48 - D[0] * 30,
    y: box.top  + 24 + ((cell / 4) | 0) * 96 + 48 - D[1] * 30,
  };
};

// 盤にモグラを並べ、カーソルを乗せて押す向きのヒントを出す
await evaluate('__t.reset([0, 2, 5, 9, 10, 15])');
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(5, 'right'), button: 'none' });
await sleep(120);
await shot('mole-board');

// 壁を向いたとき(最上段のモグラを上へ押そうとする)
await evaluate('__t.reset([0, 2, 5, 9, 10, 15])');
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(2, 'up'), button: 'none' });
await sleep(120);
await shot('mole-wall');

// 飛行中
await evaluate('__t.reset([5, 6])');
await evaluate("__t.tapAt(5, 'right')");
await sleep(100);
await shot('mole-flight');

// 終了
await evaluate('__t.reset([0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15])');
await evaluate("__t.tapAt(0,'up')");
await sleep(400);
await evaluate('__t.resume()');
await sleep(1900);
await shot('mole-over');

chrome.kill(); await sleep(300); try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
console.log('ok');
process.exit(0);
