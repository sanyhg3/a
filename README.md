# Remote Browser — VPS Setup Guide

A screenshot-based remote browser. Your VPS runs a real Chromium browser,
takes screenshots, and sends them to your phone. Your phone shows the image
and uses its **native keyboard** for input.

---

## How the keyboard trick works

Most remote desktop tools stream video — your phone sees a video frame,
not a real webpage, so the native keyboard never pops up.

This project detects **input field positions** on the remote page and draws
invisible tap zones over the screenshot. When you tap one:
1. A hidden `<input>` on your phone gets `.focus()` called → **native keyboard appears** ✅
2. You type → each keystroke is sent to the VPS → VPS types in the real browser
3. New screenshot is sent back in ~300ms

---

## VPS Setup (Ubuntu 20.04 / 22.04 / 24.04)

### 1. Install Node.js 20+
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Install system dependencies for Playwright/Chromium
```bash
sudo apt-get install -y \
  libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libasound2
```

### 3. Upload & install
```bash
# Upload the remote-browser/ folder to your VPS, then:
cd remote-browser
npm install
npm run install-browser    # downloads Chromium (~170MB)
```

### 4. Start the server
```bash
node server.js
# → Remote browser server listening on http://0.0.0.0:3000
```

### 5. Open on your phone
Visit `http://YOUR_VPS_IP:3000` in your mobile browser.

---

## Run as a persistent service (optional)

```bash
sudo npm install -g pm2
pm2 start server.js --name remote-browser
pm2 startup          # auto-start on reboot
pm2 save
```

---

## Open firewall port (if needed)

```bash
# UFW
sudo ufw allow 3000/tcp

# iptables
sudo iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
```

---

## HTTPS (for production / iOS PWA)

For HTTPS, put it behind Nginx + Let's Encrypt:

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

---

## Architecture summary

```
Mobile Browser                     VPS
─────────────────                  ──────────────────────────
[Screenshot image]  ←── WebSocket ─── [Playwright Chromium]
[Tap on input]      ──► focus msg ──► [page.focus()]
[Native keyboard]   ──► type msg  ──► [page.keyboard.type()]
[Tap anywhere]      ──► tap msg   ──► [page.mouse.click()]
[Swipe scroll]      ──► scroll    ──► [page.mouse.wheel()]
[URL bar Enter]     ──► navigate  ──► [page.goto()]
```

---

## Controls

| Action | What it does |
|--------|-------------|
| Tap on blue-bordered area | Opens native keyboard |
| Swipe up/down | Scrolls the remote page |
| URL bar | Navigate to any URL |
| ‹ › buttons | Back / Forward |
| ↻ button | Reload page |
