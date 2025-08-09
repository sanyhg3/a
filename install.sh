#!/bin/bash
# HestiaCP + Nginx FastCGI Cache + WordPress auto-installer
# For Ubuntu 22.04 with Cloudflare SSL

DOMAIN="manhwagalaxy.top"
WP_USER="Timelord"
WP_EMAIL="admin@manhwagalaxy.top"
WP_PASS=$(openssl rand -base64 14)
HESTIA_ADMIN_PASS=$(openssl rand -base64 14)

# Update system
apt update && apt upgrade -y

# Install required tools
apt install -y curl wget unzip software-properties-common

# Download and run HestiaCP installer
wget https://raw.githubusercontent.com/hestiacp/hestiacp/release/install/hst-install-ubuntu.sh
bash hst-install-ubuntu.sh \
  --apache no \
  --phpfpm yes \
  --multiphp no \
  --vsftpd no \
  --proftpd no \
  --named no \
  --mysql yes \
  --mysql8 no \
  --postgresql no \
  --exim yes \
  --dovecot yes \
  --clamav no \
  --spamassassin no \
  --iptables yes \
  --fail2ban yes \
  --quota no \
  --api yes \
  --hostname "$DOMAIN" \
  --email "$WP_EMAIL" \
  --username admin \
  --password "$HESTIA_ADMIN_PASS" \
  --interactive no

# Install WP-CLI
curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar
php wp-cli.phar --info
chmod +x wp-cli.phar
mv wp-cli.phar /usr/local/bin/wp

# Create web domain in HestiaCP
v-add-domain admin $DOMAIN

# Create MySQL DB for WordPress
DB_NAME="wp_$(openssl rand -hex 3)"
DB_USER="wp_$(openssl rand -hex 3)"
DB_PASS=$(openssl rand -base64 14)
v-add-database admin $DB_NAME $DB_USER $DB_PASS mysql

# Install WordPress
WEB_ROOT="/home/admin/web/$DOMAIN/public_html"
rm -rf $WEB_ROOT/*
cd $WEB_ROOT
wp core download --allow-root
wp config create --dbname="$DB_NAME" --dbuser="$DB_USER" --dbpass="$DB_PASS" --dbhost=localhost --allow-root
wp core install --url="https://$DOMAIN" --title="Manga Galaxy" --admin_user="$WP_USER" --admin_password="$WP_PASS" --admin_email="$WP_EMAIL" --skip-email --allow-root

# Install Nginx Helper plugin (for FastCGI purge)
wp plugin install nginx-helper --activate --allow-root

# Enable Nginx FastCGI Cache in site template
cat >/etc/nginx/conf.d/cache.conf <<EOL
fastcgi_cache_path /var/cache/nginx levels=1:2 keys_zone=WORDPRESS:100m inactive=60m;
fastcgi_cache_key "\$scheme\$request_method\$host\$request_uri";
fastcgi_cache_use_stale error timeout updating http_500 http_503;
fastcgi_cache_valid 200 301 302 60m;
EOL

# Add cache config to domain template
NGINX_CONF="/home/admin/conf/web/nginx.conf"
sed -i '/location ~ \\.php$ {/a \
    fastcgi_cache WORDPRESS;\
    fastcgi_cache_valid 200 301 302 60m;\
    add_header X-Cache \$upstream_cache_status;' $NGINX_CONF

systemctl restart nginx

# Output credentials
echo "===== INSTALL COMPLETE ====="
echo "HestiaCP URL: https://$DOMAIN:8083"
echo "HestiaCP Admin: admin"
echo "HestiaCP Password: $HESTIA_ADMIN_PASS"
echo "WordPress URL: https://$DOMAIN/wp-admin"
echo "WP Username: $WP_USER"
echo "WP Password: $WP_PASS"
echo "MySQL DB: $DB_NAME"
echo "MySQL User: $DB_USER"
echo "MySQL Pass: $DB_PASS"
