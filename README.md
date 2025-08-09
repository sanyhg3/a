# HestiaCP + WordPress FastCGI Cache Installer for manhwagalaxy.top

This script installs HestiaCP control panel with Nginx, PHP-FPM, MariaDB, and WordPress on Ubuntu 22.04.

It configures Nginx FastCGI cache for optimal performance for a manga/image-heavy site, disables Let's Encrypt SSL (since Cloudflare SSL is used), and sets up a mail server.

## How to use

1. Deploy a fresh Ubuntu 22.04 VPS.
2. SSH into VPS as root.
3. Run the installer script:

```bash
bash <(curl -s https://raw.githubusercontent.com/yourusername/hestia-fastcgi-cloudflare/main/install.sh)
