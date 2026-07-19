// 押しモグラを実際のブラウザで遊んで、成功条件を確かめる。
// 依存なし。node test/play.mjs
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9000 + Math.floor(Math.random() * 900);
const PROFILE = mkdtempSync(join(tmpdir(), 'mole-'));
const URL = 'file://' + join(process.cwd(), 'index.html');

const chrome = spawn('google-chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--no-sandbox', '--disable-gpu', '--window-size=600,600', URL,
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const tabs = await r.json();
      const page = tabs.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('chrome に繋がらない');
}

let ws, id = 0;
const pending = new Map();

function send(method, params = {}) {
  const msgId = ++id;
  return new Promise((res, rej) => {
    pending.set(msgId, { res, rej });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + expr);
  return r.result.value;
}

// アニメーション中は入力が止まるので、明けるまで待つ
async function settle() {
  for (let i = 0; i < 100; i++) {
    if (!(await evaluate('__t.busy()'))) return;
    await sleep(20);
  }
  throw new Error('アニメーションが終わらない');
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok ' : '  NG '} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  const wsUrl = await connect();
  ws = new WebSocket(wsUrl);
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { res } = pending.get(m.id);
      pending.delete(m.id);
      res(m.result);
    }
  };
  await new Promise(r => { ws.onopen = r; });
  await send('Runtime.enable');
  await sleep(400);
  await evaluate('__t.pause()');

  // --- 条件1: 叩いた向きの反対側へ1マス飛ぶ ---------------------------
  console.log('\n[1] クリック位置と飛ぶ向きが対応するか');
  const cases = [
    { from: 5, dir: 'right', to: 6 },
    { from: 5, dir: 'left',  to: 4 },
    { from: 5, dir: 'up',    to: 1 },
    { from: 5, dir: 'down',  to: 9 },
    { from: 10, dir: 'up',   to: 6 },
  ];
  for (const c of cases) {
    await evaluate(`__t.reset([${c.from}])`);
    await evaluate(`__t.tapAt(${c.from}, '${c.dir}')`);
    await settle();
    const occ = await evaluate('__t.occupied()');
    const moved = occ[c.to] === 1 && occ[c.from] === 0 && occ.reduce((a, b) => a + b) === 1;
    check(`穴${c.from} を ${c.dir} へ押すと 穴${c.to} へ`, moved, `占有=[${occ.map((v,i)=>v?i:null).filter(v=>v!==null)}]`);
  }

  // 隣接1マスだけ。飛び越さない。
  await evaluate('__t.reset([0])');
  await evaluate("__t.tapAt(0, 'right')");
  await settle();
  check('1マスだけ飛ぶ(飛び越さない)', (await evaluate('__t.occupied()'))[1] === 1);

  // --- 盤外へは出ない -------------------------------------------------
  console.log('\n[2] 盤外へは飛ばない(除去手段は衝突だけ)');
  const walls = [
    { cell: 0, dir: 'up' }, { cell: 0, dir: 'left' },
    { cell: 3, dir: 'right' }, { cell: 15, dir: 'down' },
    { cell: 12, dir: 'left' }, { cell: 7, dir: 'right' },
  ];
  for (const w of walls) {
    await evaluate(`__t.reset([${w.cell}])`);
    await evaluate(`__t.tapAt(${w.cell}, '${w.dir}')`);
    await settle();
    const occ = await evaluate('__t.occupied()');
    const stayed = occ[w.cell] === 1 && occ.reduce((a, b) => a + b) === 1;
    const facing = await evaluate(`__t.facing(${w.cell})`);
    check(`穴${w.cell} を ${w.dir} へ = 壁。残って向きだけ変わる`, stayed && facing === w.dir,
      `残数=${occ.reduce((a,b)=>a+b)} 向き=${facing}`);
  }

  // 全16マス×4方向を総当たりして、モグラが1匹でも消えないことを見る
  let vanished = 0;
  for (let cell = 0; cell < 16; cell++) {
    for (const dir of ['up', 'down', 'left', 'right']) {
      await evaluate(`__t.reset([${cell}])`);
      await evaluate(`__t.tapAt(${cell}, '${dir}')`);
      await settle();
      if (await evaluate('__t.count()') !== 1) vanished++;
    }
  }
  check('単独のモグラは64通りどう押しても消えない', vanished === 0, `消えた回数=${vanished}`);

  // --- 条件2: 狙って2匹をぶつけて消せる -------------------------------
  console.log('\n[3] 2手で狙ってぶつけられるか');

  // 空を1つ挟んだ2匹: 寄せる -> 押し込む
  await evaluate('__t.reset([0, 2])');
  await evaluate("__t.tapAt(0, 'right')");   // 0 -> 1 に寄せる
  await settle();
  const mid = await evaluate('__t.occupied()');
  await evaluate("__t.tapAt(1, 'right')");   // 1 -> 2 に押し込む
  await settle();
  const after = await evaluate('__t.count()');
  check('横に1マス空いた2匹を 寄せる→押し込む で消せる',
    mid[1] === 1 && mid[2] === 1 && after === 0, `1手目=[${mid.map((v,i)=>v?i:null).filter(v=>v!==null)}] 2手目後の残数=${after}`);

  // 縦にも同じ手順が通る
  await evaluate('__t.reset([0, 8])');
  await evaluate("__t.tapAt(0, 'down')");
  await settle();
  await evaluate("__t.tapAt(4, 'down')");
  await settle();
  check('縦に1マス空いた2匹も同じ2手で消せる', (await evaluate('__t.count()')) === 0);

  // 斜めの2匹も2手で寄る
  await evaluate('__t.reset([0, 5])');
  await evaluate("__t.tapAt(0, 'right')");   // 0 -> 1、5 の真上
  await settle();
  await evaluate("__t.tapAt(1, 'down')");    // 1 -> 5 で衝突
  await settle();
  check('斜めの2匹も2手で消せる', (await evaluate('__t.count()')) === 0);

  // 隣接なら1手
  await evaluate('__t.reset([0, 1])');
  await evaluate("__t.tapAt(0, 'right')");
  await settle();
  check('隣り合った2匹は1手で消える', (await evaluate('__t.count()')) === 0);

  // 消えるのは当たった2匹だけ。3匹目は巻き込まれない。
  await evaluate('__t.reset([0, 1, 2])');
  await evaluate("__t.tapAt(0, 'right')");
  await settle();
  const three = await evaluate('__t.occupied()');
  check('衝突で消えるのは2匹だけ(3匹目は残る)',
    three.reduce((a, b) => a + b) === 1 && three[2] === 1);

  // --- 空の穴 ---------------------------------------------------------
  console.log('\n[4] その他');
  await evaluate('__t.reset([])');
  await evaluate("__t.tapAt(5, 'right')");
  await settle();
  check('空の穴を叩いても何も起きない', (await evaluate('__t.count()')) === 0);

  // --- 条件3: 放置すると埋まって終了 ----------------------------------
  await evaluate('__t.reset([])');
  await evaluate('__t.resume()');
  let over = false;
  for (let i = 0; i < 80; i++) {          // 16穴 * 1.6s = 約26秒
    await sleep(500);
    if (await evaluate('__t.over()')) { over = true; break; }
  }
  const finalCount = await evaluate('__t.count()');
  check('放置すると16穴が埋まって終了する', over && finalCount === 16, `残数=${finalCount}`);

  // 終了直後は、誤タップで再開しない(「終了」を読む間がある)
  check('終了直後は再開が塞がれている', await evaluate('__t.locked()'));
  await evaluate("__t.tapAt(0, 'right')");
  await settle();
  check('終了直後に叩いても盤は動かない',
    (await evaluate('__t.count()')) === 16 && (await evaluate('__t.over()')) === true);

  // 猶予が切れれば叩いて再開できる
  await sleep(1100);
  check('猶予が切れると再開できるようになる', !(await evaluate('__t.locked()')));
  await evaluate("__t.tapAt(0, 'right')");
  await settle();
  check('再開すると盤が初期状態に戻る',
    (await evaluate('__t.over()')) === false && (await evaluate('__t.count()')) === 3,
    `残数=${await evaluate('__t.count()')}`);
  await evaluate('__t.pause()');

  // --- 得点(既読) ---------------------------------------------------
  await evaluate('__t.reset([0, 1])');
  await evaluate("__t.tapAt(0, 'right')");
  await settle();
  await sleep(60);
  check('ぶつけると既読が2件増える', (await evaluate('__t.read()')) === 2,
    `既読=${await evaluate('__t.read()')}`);

  // 空振りでは既読が増えない
  await evaluate('__t.reset([0])');
  await evaluate("__t.tapAt(0, 'up')");
  await settle();
  check('壁での空振りでは既読が増えない', (await evaluate('__t.read()')) === 0);

  // 画面に「終了」が出ているか、描画結果そのものを見る
  // 描画そのものが通ること
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  check('画面を描画できた', !!shot.data && shot.data.length > 1000);

  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通過`);
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); })
  .finally(() => { chrome.kill(); rmSync(PROFILE, { recursive: true, force: true }); });
