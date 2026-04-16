const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const browser = require('./browser');
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const CLIENTS = new Set();
let currentSpecs = { w: 0, h: 0, dpr: 0, ua: '' };
let screencastStarted = false;

setInterval(async () => {
  if (browser.isPageReady()) {
    cachedRects = await browser.getInputRects();
    cachedMetaPayload = JSON.stringify({ type: 'meta', url: browser.page.url(), inputRects: cachedRects });
  }
}, 1000);

// --- THE SMOOTHNESS ENGINE ---
let lastFrameTime = 0;

function handleFrame(data, sessionId) {
  if (!browser.activeCDP) return;
  const now = Date.now();

  // limit to 10 FPS
  if (now - lastFrameTime < 100) {
    browser.activeCDP.send('Page.screencastFrameAck', { sessionId }).catch(()=>{});
    return;
  }

  lastFrameTime = now;

  const buffer = Buffer.from(data, 'base64');

  for (const ws of CLIENTS) {
    if (ws.readyState === 1 && ws.bufferedAmount < 50000) {
      ws.send(cachedMetaPayload);
      ws.send(buffer, { binary: true });
    }
  }

  browser.activeCDP.send('Page.screencastFrameAck', { sessionId }).catch(()=>{});
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

      switch (msg.type) {
        case 'init':
          if (!browser.isPageReady() || currentSpecs.w !== msg.w || currentSpecs.h !== msg.h || currentSpecs.dpr !== msg.dpr) {
            currentSpecs = { w: msg.w, h: msg.h, dpr: msg.dpr, ua: msg.ua };
            await browser.startNativeBrowser(msg.w, msg.h, msg.dpr, msg.ua);
          }

          if (browser.activeCDP && !screencastStarted) {
            screencastStarted = true;
            const client = browser.activeCDP;

            if (!browser.screencastListenerAttached) {
              browser.screencastListenerAttached = true;
              client.on('Page.screencastFrame', ({ data, sessionId }) => {
                handleFrame(data, sessionId);
              });
            }

            await client.send('Page.startScreencast', {
              format: 'jpeg',
              quality: 35,
              maxWidth: Math.round(currentSpecs.w),
              maxHeight: Math.round(currentSpecs.h),
              everyNthFrame: 1
            }).catch(()=>{});
          }
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
        case 'edit':
          if (browser.activeCDP) {
            // BACKSPACE FIRST
            for (let i = 0; i < (msg.backspace || 0); i++) {
              await browser.activeCDP.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: 'Backspace',
                code: 'Backspace',
                windowsVirtualKeyCode: 8,
                nativeVirtualKeyCode: 8
              }).catch(()=>{});

              await browser.activeCDP.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: 'Backspace',
                code: 'Backspace',
                windowsVirtualKeyCode: 8,
                nativeVirtualKeyCode: 8
              }).catch(()=>{});
            }

            // INSERT TEXT
            if (msg.text && msg.text.length > 0) {
              await browser.activeCDP.send('Input.insertText', {
                text: msg.text
              }).catch(()=>{});
            }
          }
          break;
        case 'type':
          if (browser.activeCDP) {
            await browser.activeCDP.send('Input.insertText', {
              text: msg.text
            }).catch(() => {});
          }
          break;
        case 'key':
          if (browser.activeCDP) {
            await browser.activeCDP.send('Input.dispatchKeyEvent', {
              type: 'keyDown',
              key: msg.key
            }).catch(() => {});

            await browser.activeCDP.send('Input.dispatchKeyEvent', {
              type: 'keyUp',
              key: msg.key
            }).catch(() => {});
          }
          break;
        case 'mousedown': browser.page.mouse.move(msg.x, msg.y).then(() => browser.page.mouse.down({ button: 'left' })).catch(()=>{}); break;
        case 'mousemove': browser.page.mouse.move(msg.x, msg.y, { steps: 2 }).catch(()=>{}); break;
        case 'mouseup': browser.page.mouse.up({ button: 'left' }).catch(()=>{}); break;
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  ws.on('close', async () => {
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
