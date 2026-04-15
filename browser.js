const { chromium } = require('playwright');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, 'saved_browser_profile');

class BrowserController {
  constructor() {
    this.context = null;
    this.page = null;
    this.activeCDP = null;
    this.onFrameNavigatedCallback = null;
  }

  async startNativeBrowser(w, h, dpr, ua, onFrameNavigated) {
    if (onFrameNavigated) this.onFrameNavigatedCallback = onFrameNavigated;

    if (this.context) {
        try { await this.context.close(); } catch (e) {}
        this.context = null;
        this.page = null;
    }

    console.log(`?? Booting Native Engine: ${w}x${h} (DPR: ${dpr})`);

    try {
        this.context = await chromium.launchPersistentContext(USER_DATA_DIR, {
          headless: false,
          viewport: { width: Math.round(w), height: Math.round(h) },
          deviceScaleFactor: dpr,
          userAgent: ua,
          isMobile: true,
          hasTouch: true,

          locale: 'en-US',
          timezoneId: 'America/New_York',
          permissions: ['geolocation'],

          extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
            'Sec-CH-UA-Mobile': '?1',
            'Sec-CH-UA-Platform': '"Android"'
          },

          colorScheme: 'no-preference',
          args: [
            '--window-size=1500,3000',
            '--window-position=0,0',
            '--hide-scrollbars',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-crash-reporter',
            '--disable-accelerated-video-decode',
            '--autoplay-policy=no-user-gesture-required',

            '--disable-background-timer-throttling',
            '--disable-renderer-backgrounding',
            '--disable-backgrounding-occluded-windows',
            '--enable-gpu',

            '--disable-software-rasterizer',
            '--disable-lcd-text',
            '--enable-font-antialiasing'
          ],
        });

        await this.context.addCookies([{ name: 'PREF', value: 'hl=en&tz=America.New_York', domain: '.google.com', path: '/' }]);

        await this.context.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          window.addEventListener('DOMContentLoaded', () => {
            const style = document.createElement('style');
            style.textContent = `
              body, p, span, div, input, button, textarea {
                font-family: Roboto, -apple-system, sans-serif;
              }
              * {
                animation: none !important;
                transition: none !important;
              }
            `;
            document.head.appendChild(style);

            // Prevent render throttling
            setInterval(() => {
              document.body.style.transform = `translateZ(${Math.random()}px)`;
            }, 100);
          });
        });

        const pages = this.context.pages();
        this.page = pages.length > 0 ? pages[0] : await this.context.newPage();

        try {
          this.activeCDP = await this.page.context().newCDPSession(this.page);
          await this.activeCDP.send('Emulation.setDeviceMetricsOverride', {
            width: Math.round(w),
            height: Math.round(h),
            deviceScaleFactor: dpr,
            mobile: true,
            screenWidth: Math.round(w),
            screenHeight: Math.round(h)
          });
        } catch (e) {
          console.error('CDP Initialization Error:', e);
        }

        // Add crash handling
        this.page.on('crash', async () => {
             console.log('?? Page crashed! Restarting...');
             await this.startNativeBrowser(w, h, dpr, ua, this.onFrameNavigatedCallback);
        });

        await this.page.goto('https://m.facebook.com', { waitUntil: 'domcontentloaded' }).catch(e => console.error('Navigation error:', e));
        console.log('?? Native Browser Ready ?? m.facebook.com');

        this.page.on('framenavigated', async (frame) => {
          if (frame === this.page.mainFrame()) {
            if (this.onFrameNavigatedCallback) this.onFrameNavigatedCallback();
          }
        });
    } catch (e) {
        console.error('Browser Initialization Error:', e);
    }
  }

  async getInputRects() {
    try {
      if (!this.page || this.page.isClosed()) return [];
      return await this.page.evaluate(() => {
        const selectors = 'input:not([type=hidden]), textarea, [contenteditable="true"], [role="textbox"]';
        return Array.from(document.querySelectorAll(selectors)).map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
      });
    } catch {
      return [];
    }
  }

  async close() {
    try {
        if (this.context) {
          await this.context.close();
          this.context = null;
          this.page = null;
          this.activeCDP = null;
        }
    } catch (e) {
        console.error('Browser close error:', e);
    }
  }

  isPageReady() {
    return this.page && !this.page.isClosed();
  }
}

module.exports = new BrowserController();
