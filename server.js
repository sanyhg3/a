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
let latestFrame = null;

function handleFrame(data, sessionId) {
  if (!browser.activeCDP) return;

  // ALWAYS ACK immediately (CRITICAL)
  browser.activeCDP.send('Page.screencastFrameAck', { sessionId }).catch(()=>{});

  // Store latest frame (overwrite old)
  latestFrame = data;
}

setInterval(() => {
  if (!latestFrame) return;

  const buffer = Buffer.from(latestFrame, 'base64');

  for (const ws of CLIENTS) {
    if (ws.readyState === 1 && ws.bufferedAmount < 50000) {
      ws.send(cachedMetaPayload);
      ws.send(buffer, { binary: true });
    }
  }

  // clear after sending
  latestFrame = null;

}, 100); // 10 FPS

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
            const promises = [];

            // 1. BACKSPACE (QUEUE ALL)
            for (let i = 0; i < (msg.backspace || 0); i++) {
              promises.push(
                browser.activeCDP.send('Input.dispatchKeyEvent', {
                  type: 'keyDown',
                  key: 'Backspace',
                  code: 'Backspace',
                  windowsVirtualKeyCode: 8
                }).catch(()=>{})
              );

              promises.push(
                browser.activeCDP.send('Input.dispatchKeyEvent', {
                  type: 'keyUp',
                  key: 'Backspace',
                  code: 'Backspace',
                  windowsVirtualKeyCode: 8
                }).catch(()=>{})
              );
            }

            // 2. TYPE TEXT (QUEUE ALL)
            if (msg.text && msg.text.length > 0) {
              for (const ch of msg.text) {
                promises.push(
                  browser.activeCDP.send('Input.dispatchKeyEvent', {
                    type: 'char',
                    text: ch
                  }).catch(()=>{})
                );
              }
            }

            // 3. EXECUTE IN PARALLEL
            Promise.all(promises).catch(()=>{});
          }
          break;
        case 'type':
          if (browser.activeCDP && msg.text && msg.text.length > 0) {
            const typePromises = [];
            for (const ch of msg.text) {
              typePromises.push(
                browser.activeCDP.send('Input.dispatchKeyEvent', {
                  type: 'char',
                  text: ch
                }).catch(()=>{})
              );
            }
            Promise.all(typePromises).catch(()=>{});
          }
          break;
        case 'key':
          if (browser.activeCDP) {
            const keyPromises = [
              browser.activeCDP.send('Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: msg.key
              }).catch(() => {}),
              browser.activeCDP.send('Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: msg.key
              }).catch(() => {})
            ];
            Promise.all(keyPromises).catch(()=>{});
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
