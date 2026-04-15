const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const browser = require('./browser');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const CLIENTS = new Set();
let currentSpecs = { w: 0, h: 0, dpr: 0, ua: '' };

setInterval(async () => {
  if (browser.isPageReady()) {
    cachedRects = await browser.getInputRects();
    cachedMetaPayload = JSON.stringify({ type: 'meta', url: browser.page.url(), inputRects: cachedRects });
  }
}, 1000);

let lastFrameHash = null;

// --- THE SMOOTHNESS ENGINE ---
let capturing = false;
let lastInputTime = 0;

let inFlight = 0;
const MAX_IN_FLIGHT = 3;
let burstFrames = 0;
let latestCaptureId = 0;
let latestSentCaptureId = 0;

function broadcastFrame(buffer) {
  const hash = crypto.createHash('md5').update(buffer).digest('hex');

  if (hash === lastFrameHash) return false;
  lastFrameHash = hash;

  let sentToAnyone = false;
  for (const ws of CLIENTS) {
    if (ws.readyState !== 1) continue;
    if (ws.bufferedAmount > 10000) continue;

    ws.send(cachedMetaPayload);

    ws.send(buffer, { binary: true });
    sentToAnyone = true;
  }
  return sentToAnyone;
}

async function captureLoop() {
  if (capturing) return;
  capturing = true;

  while (browser.isPageReady() && CLIENTS.size > 0) {
    const allBackedUp = [...CLIENTS].every(ws => ws.bufferedAmount > 10000);

    if (allBackedUp) {
      await new Promise(r => setTimeout(r, 16));
      continue;
    }

    if (inFlight < MAX_IN_FLIGHT) {
      inFlight++;
      const captureId = ++latestCaptureId;

      browser.page.screenshot({
        type: 'jpeg',
        quality: 35,
        optimizeForSpeed: true
      }).then(buffer => {
        if (captureId < latestSentCaptureId) return;
        latestSentCaptureId = Math.max(latestSentCaptureId, captureId);
        broadcastFrame(buffer);
      }).catch(() => {})
      .finally(() => {
        inFlight--;
      });
    }

    if (burstFrames > 0) {
      burstFrames--;
      await new Promise(r => setImmediate(r));
    } else {
      const isActive = Date.now() - lastInputTime < 500;

      if (!isActive) {
        await new Promise(r => setTimeout(r, 80));
      } else {
        await new Promise(r => setImmediate(r));
      }
    }
  }

  capturing = false;
}

async function triggerRawDump() {
  lastInputTime = Date.now();
  burstFrames = 20;

  if (CLIENTS.size > 0) {
    captureLoop();
  }
}

let cachedRects = []; 
let cachedMetaPayload = JSON.stringify({ type: 'meta', url: '', inputRects: [] });

const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('connection', async (ws, req) => {
  console.log('?? Client connected');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  
  try { if (ws._socket) ws._socket.setNoDelay(true); } catch (err) {}
  CLIENTS.add(ws);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    try {
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({
          type: 'pong',
          ts: msg.ts
        }));
        return;
      }

      if (['tap', 'scroll', 'type', 'key', 'navigate', 'back', 'forward', 'mousedown', 'mousemove', 'mouseup'].includes(msg.type)) {
        triggerRawDump();
      }

      switch (msg.type) {
        case 'init':
          if (!browser.isPageReady() || currentSpecs.w !== msg.w || currentSpecs.h !== msg.h || currentSpecs.dpr !== msg.dpr) {
            currentSpecs = { w: msg.w, h: msg.h, dpr: msg.dpr, ua: msg.ua };
            await browser.startNativeBrowser(msg.w, msg.h, msg.dpr, msg.ua, triggerRawDump);
          }
          triggerRawDump();
          break;
        case 'navigate': browser.page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{}); break;
        case 'back': browser.page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); break;
        case 'forward': browser.page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {}); break;
        case 'reload': browser.page.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{}); break;
        case 'tap': 
          browser.page.touchscreen.tap(msg.x, msg.y).then(() => {
            setTimeout(() => {
              if (!browser.isPageReady()) return;
              browser.page.evaluate(() => {
                const el = document.activeElement;
                if (el && (['INPUT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable)) {
                  el.scrollIntoView({ block: 'center' });
                }
              }).catch(() => {}); 
            }, 300);
          }).catch(()=>{}); 
          break;
        case 'scroll': browser.page.mouse.wheel(0, msg.dy).catch(()=>{}); break;
        case 'type':
          await browser.page.keyboard.type(msg.text, { delay: 0 }).catch(()=>{});
          burstFrames = 20;
          lastInputTime = Date.now();
          break;
        case 'key':
          await browser.page.keyboard.press(msg.key).catch(()=>{});
          burstFrames = 20;
          lastInputTime = Date.now();
          break;
        case 'mousedown': browser.page.mouse.move(msg.x, msg.y).then(() => browser.page.mouse.down({ button: 'left' })).catch(()=>{}); break;
        case 'mousemove': browser.page.mouse.move(msg.x, msg.y, { steps: 2 }).catch(()=>{}); break;
        case 'mouseup': browser.page.mouse.up({ button: 'left' }).catch(()=>{}); break;
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', () => { 
    CLIENTS.delete(ws); 
    console.log('?? Client disconnected'); 
  });
});

wss.on('close', () => { clearInterval(interval); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`?? Remote browser server listening on http://0.0.0.0:${PORT}`);
});

process.on('SIGINT', async () => {
  await browser.close();
  process.exit(0);
});
