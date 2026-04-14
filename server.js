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

let isDumpingFrames = false;
let dumpTimeout = null;

setInterval(async () => {
  if (browser.isPageReady()) {
    cachedRects = await browser.getInputRects();
    cachedMetaPayload = JSON.stringify({ type: 'meta', url: browser.page.url(), inputRects: cachedRects });
  }
}, 1000);

let lastFrameHash = null;

// --- THE SMOOTHNESS ENGINE ---
async function triggerRawDump() {
  if (CLIENTS.size === 0) {
      isDumpingFrames = false;
      return;
  }

  if (isDumpingFrames) {
    clearTimeout(dumpTimeout);
    dumpTimeout = setTimeout(() => { isDumpingFrames = false; }, 4000);
    return;
  }
  
  isDumpingFrames = true;
  clearTimeout(dumpTimeout);
  dumpTimeout = setTimeout(() => { isDumpingFrames = false; }, 4000);

  while (isDumpingFrames && browser.isPageReady() && CLIENTS.size > 0) {
    try {
      // 1. The Sweet Spot: JPEG 80% is extremely sharp but encodes incredibly fast!
      const buffer = await browser.page.screenshot({ type: 'jpeg', quality: 80 });
      
      // Frame deduplication using MD5 hash (fast enough for small JPEGs)
      const currentHash = crypto.createHash('md5').update(buffer).digest('hex');
      if (currentHash === lastFrameHash) {
        // Frame is identical, skip sending, just wait and try again
        await new Promise(resolve => setTimeout(resolve, 16));
        continue;
      }
      lastFrameHash = currentHash;

      let sentToAnyone = false;
      for (const ws of CLIENTS) {
        // 2. The Zero-Latency Buffer: Dropped to 500KB to aggressively drop frames if client falls behind
        if (ws.readyState === 1) {
            if (ws.bufferedAmount < 500000) {
              ws.send(cachedMetaPayload);
              ws.send(buffer);
              sentToAnyone = true;
            } else {
               // Drop frame, do not send to prevent queue buildup
            }
        }
      }
      
      // 3. The Uncap: 16ms delay targets a blistering 60 FPS output.
      const delay = sentToAnyone ? 16 : 200; 
      await new Promise(resolve => setTimeout(resolve, delay)); 
    } catch (err) {
      await new Promise(resolve => setTimeout(resolve, 100)); // Retry rather than breaking the loop permanently
    }
  }
  isDumpingFrames = false;
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
                  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
              }).catch(() => {}); 
            }, 300);
          }).catch(()=>{}); 
          break;
        case 'scroll': browser.page.mouse.wheel(0, msg.dy).catch(()=>{}); break;
        case 'type': browser.page.keyboard.type(msg.text, { delay: 0 }).catch(()=>{}); break;
        case 'key': browser.page.keyboard.press(msg.key).catch(()=>{}); break;
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
    if (CLIENTS.size === 0) {
        isDumpingFrames = false; // Stop the loop cleanly
    }
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
