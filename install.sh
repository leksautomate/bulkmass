#!/bin/bash

# Default values
APP_PORT=5000
DOMAIN=""
APP_DIR="/home/$USER/bulkmass"

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --port) APP_PORT="$2"; shift ;;
        --domain) DOMAIN="$2"; shift ;;
        *) echo "Unknown parameter passed: $1"; exit 1 ;;
    esac
    shift
done

echo "=========================================="
echo "      BULKMASS INSTALLER (VPS)           "
echo "=========================================="
echo "Port: $APP_PORT"
echo "Domain: ${DOMAIN:-None (IP access only)}"
echo "=========================================="

# 1. Update System & Install Dependencies
echo "[1/6] Updating system..."
sudo apt-get update -y
sudo apt-get install -y curl git build-essential nginx ufw

# 2. Install Node.js 18+
echo "[2/6] Installing Node.js..."
if ! command -v node &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "Node.js is already installed."
fi

# 3. Install PM2
echo "[3/6] Installing PM2..."
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
else
    echo "PM2 is already installed."
fi

# 4. Configure App
echo "[4/6] Configuring Application..."
# Create .env if missing
if [ ! -f .env ]; then
    cp .env.example .env 2>/dev/null || touch .env
fi

# Update PORT in ecosystem.config.js
# We use sed to replace "PORT: 5000" with "PORT: <APP_PORT>"
if [ -f ecosystem.config.js ]; then
    sed -i "s/PORT: [0-9]*/PORT: $APP_PORT/" ecosystem.config.js
    echo "Updated ecosystem.config.js with port $APP_PORT"
fi

# Install App Dependencies
echo "Installing npm packages..."
npm install --production

# 5. Configure Firewall & Nginx
echo "[5/6] Configuration Network..."

# Setup UFW
sudo ufw allow ssh
sudo ufw allow http
sudo ufw allow https
sudo ufw allow $APP_PORT/tcp
# Enable ufw if not enabled? (Be careful not to lock user out, usually better to leave enabling to user or ensure ssh is allowed)
# sudo ufw --force enable 

# Setup Nginx
NGINX_CONF="/etc/nginx/sites-available/bulkmass"
sudo rm -f $NGINX_CONF

# Create Nginx Config
sudo bash -c "cat > $NGINX_CONF" <<EOF
server {
    listen 80;
    server_name ${DOMAIN:-_};

    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

# Enable Site
sudo ln -sf $NGINX_CONF /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl restart nginx

# 6. Start Application
echo "[6/6] Starting Application..."
pm2 delete bulkmass 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup | grep "sudo" | bash # Execute the command pm2 output tells us to run

echo ""
echo "=========================================="
echo "      INSTALLATION COMPLETE!             "
echo "=========================================="
echo "App running on port: $APP_PORT"
if [ -n "$DOMAIN" ]; then
    echo "Access via: http://$DOMAIN"
else
    echo "Access via: http://<YOUR_VPS_IP>"
fi
echo "=========================================="
