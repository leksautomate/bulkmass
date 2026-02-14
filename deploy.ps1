<#
.SYNOPSIS
    One-Click Deploy Script for Bulkmass
    Deploys the current project to a remote VPS.

.DESCRIPTION
    1. Prompts for VPS IP, User, and desired App Port.
    2. Zips the project files (excluding node_modules).
    3. SCPs the zip to the VPS.
    4. SSHs into VPS to unzip and run install.sh.

.EXAMPLE
    .\deploy.ps1
#>

$ErrorActionPreference = "Stop"

function Prompt-Input {
    param([string]$Message, [string]$DefaultValue)
    if ($DefaultValue) {
        $Input = Read-Host "$Message [$DefaultValue]"
        if (-not $Input) { return $DefaultValue }
        return $Input
    }
    return Read-Host "$Message"
}

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "      BULKMASS ONE-CLICK DEPLOYer         " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 1. Gather Info
$VpsIp = Prompt-Input "Enter VPS IP Address"
if (-not $VpsIp) { Write-Error "VPS IP is required."; exit }

$VpsUser = Prompt-Input "Enter VPS Username" "root"
$TargetPort = Prompt-Input "Enter Port to Run App On" "5000"
$Domain = Prompt-Input "Enter Domain Name (Optional, press Enter to skip)" ""

$RemoteDir = "/home/$VpsUser/bulkmass"
$ZipName = "bulkmass_deploy.zip"

# 2. Prepare Files
Write-Host "`n[1/4] Zipping project files..." -ForegroundColor Yellow
if (Test-Path $ZipName) { Remove-Item $ZipName }

# List of files/folders to include
$Include = @(
    "server.js",
    "app.js",
    "queue.js",
    "worker.js",
    "package.json",
    "package-lock.json",
    "ecosystem.config.js",
    "install.sh",
    ".env.example",
    "index.html",
    "styles.css",
    "whisk-api-source"
)

Compress-Archive -Path $Include -DestinationPath $ZipName -Force

# 3. Upload to VPS
Write-Host "`n[2/4] Uploading to $VpsUser@$VpsIp..." -ForegroundColor Yellow
$ScpCommand = "scp $ZipName $VpsUser@$VpsIp`:$RemoteDir.zip"
Invoke-Expression $ScpCommand
if ($LASTEXITCODE -ne 0) { Write-Error "Upload failed. Check SSH connection/keys."; exit }

# 4. Remove Local Zip
Remove-Item $ZipName

# 5. Remote Execute
Write-Host "`n[3/4] Running remote installer..." -ForegroundColor Yellow

$RemoteScript = @"
mkdir -p $RemoteDir
mv ~/$RemoteDir.zip $RemoteDir/deploy.zip
cd $RemoteDir
# Install unzip if missing
if ! command -v unzip &> /dev/null; then
    if [ -x "\$(command -v apt-get)" ]; then sudo apt-get update && sudo apt-get install -y unzip; fi
fi
unzip -o deploy.zip
chmod +x install.sh
sudo ./install.sh --port $TargetPort --domain '$Domain'
"@

# Fix newlines for passing via SSH
$RemoteScriptFlat = $RemoteScript -replace "`r`n", "`n"

ssh -t $VpsUser@$VpsIp "bash -c '$RemoteScriptFlat'"

Write-Host "`n[4/4] Deployment Finished!" -ForegroundColor Green
Write-Host "Check the output above for the URL." -ForegroundColor Green
