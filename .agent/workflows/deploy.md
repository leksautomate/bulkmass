---
description: How to deploy Bulkmass to a VPS server
---

# Deploy Bulkmass to VPS

## Prerequisites
- Ubuntu/Debian VPS with root or sudo access
- Node.js 18+ installed
- PM2 installed globally (`npm install -g pm2`)
- Nginx installed (for reverse proxy)
- Domain name pointed to your VPS IP (optional but recommended)

## 1. Upload Project Files

// turbo-all

Copy the project to your VPS (from local machine):
```bash
scp -r ./Bulkmass user@your-vps-ip:/home/user/bulkmass
```

Or clone from git:
```bash
git clone your-repo-url /home/user/bulkmass
```

## 2. Setup on VPS

SSH into your VPS:
```bash
ssh user@your-vps-ip
```

Navigate to the project directory:
```bash
cd /home/user/bulkmass
```

Install dependencies:
```bash
npm install --production
```

Copy the whisk-api-source folder if using local API:
```bash
# Make sure whisk-api-source/dist/index.js exists on the VPS
```

Create environment file:
```bash
cp .env.example .env
```

Edit the .env if you want a different port:
```bash
nano .env
```

Create the logs directory:
```bash
mkdir -p logs
```

## 3. Start with PM2

Start the application:
```bash
pm2 start ecosystem.config.js
```

Verify it's running:
```bash
pm2 status
pm2 logs bulkmass
```

Set PM2 to start on boot:
```bash
pm2 save
pm2 startup
```

## 4. Setup Nginx Reverse Proxy

Create an Nginx config file:
```bash
sudo nano /etc/nginx/sites-available/bulkmass
```

Paste this configuration (replace `yourdomain.com` with your domain or VPS IP):
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # Max upload size for prompt files
    client_max_body_size 5M;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;

        # Timeouts for long-running image generation
        proxy_connect_timeout 60s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;
    }
}
```

Enable the site and restart Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/bulkmass /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

## 5. SSL with Let's Encrypt (Optional but Recommended)

Install Certbot:
```bash
sudo apt install certbot python3-certbot-nginx
```

Get SSL certificate:
```bash
sudo certbot --nginx -d yourdomain.com
```

Auto-renewal is set up automatically. Test it:
```bash
sudo certbot renew --dry-run
```

## 6. Useful PM2 Commands

| Command | Description |
|---|---|
| `pm2 status` | Check app status |
| `pm2 logs bulkmass` | View live logs |
| `pm2 restart bulkmass` | Restart the app |
| `pm2 stop bulkmass` | Stop the app |
| `pm2 delete bulkmass` | Remove from PM2 |
| `pm2 monit` | Real-time monitoring dashboard |

## 7. Updating the App

```bash
cd /home/user/bulkmass
git pull                    # or re-upload files
npm install --production    # if deps changed
pm2 restart bulkmass
```
