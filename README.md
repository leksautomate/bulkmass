Bulkmass

Bulkmass is a bulk image generation tool powered by the Whisk API. It features a stateless server that proxies requests, a robust frontend for managing generations, and a streamlined deployment process.

## Features
- **Bulk Generation**: Generate multiple images at once using the Whisk API.
- **Stateless Proxy**: Server handles API communication securely.
- **Responsive UI**: Modern, dark-mode interface for managing prompts and results.

## Local Development

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Configure Environment**
   Copy `.env.example` to `.env` (optional, defaults provided):
   ```bash
   cp .env.example .env
   ```

3. **Start Server**
   ```bash
   npm start
   ```
   The app will run at `http://localhost:5000`.

## 🚀 One-Click Deployment (VPS)

You can deploy the application to any Ubuntu/Debian VPS with a single command from your local Windows machine.

### Prerequisites
- A VPS (Ubuntu/Debian) with SSH access.
- **PowerShell** (Standard on Windows).

### How to Deploy

1. Open **PowerShell** in this directory.
2. Run the deployment script:
   ```powershell
   .\deploy.ps1
   ```
3. Follow the prompts:
   - **VPS IP**: Enter your server's IP address.
   - **VPS User**: Enter the username (usually `root`).
   - **App Port**: Choose the port (default `5000`).
   - **Domain**: (Optional) Enter your domain name for Nginx configuration.

The script will automatically:
- Zip your project files.
- Upload them to the server.
- Install Node.js, PM2, and Nginx (if missing).
- Configure the firewall and Nginx reverse proxy.
- Start the application.

### Updating the App

**Option A: From your local Windows machine**

Simply run the deploy script again — it will re-upload your latest files and restart the app:
```powershell
.\deploy.ps1
```

**Option B: Directly on the VPS via SSH**

If you are already logged into your VPS, pull the latest changes from GitHub and restart:
```bash
cd ~/bulkmass
git pull origin main
npm install
npx tsc --project whisk-api-source/
pm2 restart bulkmass
```

## 🖥️ Direct Installation on VPS

If you are already logged into your VPS via SSH and have the files there (e.g., via `git clone`), run:

```bash
# Clone the repository
git clone https://github.com/leksautomate/bulkmass.git

# Enter the directory (CRITICAL!)
cd bulkmass

# Make installer executable
chmod +x install.sh

# Run installer
./install.sh
```

This will run the same installation steps directly on the server.
