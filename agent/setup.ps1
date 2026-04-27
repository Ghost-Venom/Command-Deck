<#
.SYNOPSIS
    Command Deck — Windows agent setup.

.DESCRIPTION
    Interactive bootstrap that:
      - Verifies Node.js is installed
      - Generates config.json (prompting for shared secret, port, Outlook integration)
      - Installs npm dependencies
      - Optionally opens the Windows Firewall on the configured port
      - Optionally registers the agent with PM2 for autostart

    Re-run is safe; the script asks before overwriting existing config.

.PARAMETER Uninstall
    Remove PM2 registration and firewall rule. Files in this directory are NOT deleted.

.EXAMPLE
    .\setup.ps1
.EXAMPLE
    .\setup.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServiceName = 'command-deck-agent'
$FirewallRuleName = 'Command Deck Agent'

function Write-Say  { param($Msg) Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-Ok   { param($Msg) Write-Host "[OK] $Msg" -ForegroundColor Green }
function Write-Warn2 { param($Msg) Write-Host "[!]  $Msg" -ForegroundColor Yellow }
function Write-Err  { param($Msg) Write-Host "[X]  $Msg" -ForegroundColor Red }

function Ask-Input {
    param([string]$Question, [string]$Default = '')
    if ($Default) { $prompt = "$Question [$Default]" } else { $prompt = $Question }
    $ans = Read-Host $prompt
    if ([string]::IsNullOrWhiteSpace($ans)) { return $Default } else { return $ans }
}

function Ask-Yes {
    param([string]$Question, [bool]$Default = $false)
    $hint = if ($Default) { '[Y/n]' } else { '[y/N]' }
    $ans = Read-Host "$Question $hint"
    if ([string]::IsNullOrWhiteSpace($ans)) { return $Default }
    return $ans -match '^[Yy]'
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}

# ---------- Uninstall ----------
if ($Uninstall) {
    Write-Say "Uninstalling Command Deck agent (files preserved)"

    # PM2 cleanup
    $pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
    if ($pm2) {
        try {
            pm2 stop $ServiceName 2>$null
            pm2 delete $ServiceName 2>$null
            pm2 save 2>$null
            Write-Ok "removed PM2 process"
        } catch { Write-Warn2 "PM2 cleanup warning: $_" }
    }

    # Firewall rule
    $rule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
    if ($rule) {
        if (Test-Admin) {
            Remove-NetFirewallRule -DisplayName $FirewallRuleName
            Write-Ok "removed firewall rule"
        } else {
            Write-Warn2 "Firewall rule exists but cannot be removed without admin. Re-run as Administrator to clean up."
        }
    }
    Write-Ok "uninstall complete. Files in $ScriptDir preserved."
    exit 0
}

# ---------- Banner ----------
Write-Host ""
Write-Host "Command Deck - Windows Agent Setup" -ForegroundColor White
Write-Host ""

# ---------- 1. Node.js ----------
Write-Say "Checking Node.js"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    Write-Ok "Node found: $(node --version)"
} else {
    Write-Err "Node.js is not installed."
    Write-Host "    Download the LTS installer from https://nodejs.org and re-run this script."
    Read-Host "    Press Enter to open the download page in your browser"
    Start-Process 'https://nodejs.org'
    exit 1
}

# ---------- 2. npm install ----------
Write-Say "Installing npm dependencies"
Push-Location $ScriptDir
try {
    npm install --silent --no-fund --no-audit
    Write-Ok "dependencies installed"
} finally {
    Pop-Location
}

# ---------- 3. Config ----------
Write-Say "Configuration"
$ConfigFile = Join-Path $ScriptDir 'config.json'
$ExampleFile = Join-Path $ScriptDir 'config.example.json'

if (Test-Path $ConfigFile) {
    if (Ask-Yes "config.json already exists. Re-run config wizard? (will overwrite)" $false) {
        Remove-Item $ConfigFile
    } else {
        Write-Warn2 "skipping config wizard"
    }
}

if (-not (Test-Path $ConfigFile)) {
    # Generate or accept secret
    $genSecret = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Maximum 256) })
    Write-Host ""
    Write-Host "Shared secret (paste this same value into the Pi config):"
    Write-Host "  $genSecret" -ForegroundColor Yellow
    Write-Host ""
    if (Ask-Yes "Use this generated secret?" $true) {
        $secret = $genSecret
    } else {
        $secret = Ask-Input "Enter your own secret (min 16 chars)"
        if ($secret.Length -lt 16) { Write-Err "secret too short"; exit 1 }
    }

    $port = Ask-Input "Agent port" '5000'

    Write-Host ""
    Write-Host "Outlook integration uses COM and only works with classic Outlook (not 'new Outlook')."
    $outlookEnabled = Ask-Yes "Enable Outlook integration?" $false
    $outlookExe = 'C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE'
    if ($outlookEnabled) {
        # Try to auto-detect classic exe
        $candidates = @(
            'C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE',
            'C:\Program Files (x86)\Microsoft Office\root\Office16\OUTLOOK.EXE',
            'C:\Program Files\Microsoft Office\Office16\OUTLOOK.EXE',
            'C:\Program Files (x86)\Microsoft Office\Office16\OUTLOOK.EXE'
        )
        $found = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
        if ($found) {
            Write-Ok "found classic Outlook at: $found"
            $outlookExe = $found
        } else {
            Write-Warn2 "classic Outlook not found in standard locations"
            $outlookExe = Ask-Input "Path to classic Outlook .exe (or press Enter to use default)" $outlookExe
        }
    }

    # Build the config object and write it
    $cfg = Get-Content $ExampleFile -Raw | ConvertFrom-Json
    $cfg.port = [int]$port
    $cfg.sharedSecret = $secret
    $cfg.outlook.enabled = $outlookEnabled
    $cfg.outlook.exePath = $outlookExe
    $cfg | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 $ConfigFile
    Write-Ok "config.json written"
}

# ---------- 4. Firewall ----------
$cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json
$port = $cfg.port

Write-Say "Windows Firewall"
$existingRule = Get-NetFirewallRule -DisplayName $FirewallRuleName -ErrorAction SilentlyContinue
if ($existingRule) {
    Write-Ok "firewall rule already exists"
} else {
    if (Ask-Yes "Add Windows Firewall rule allowing inbound TCP $port from Private networks?" $true) {
        if (Test-Admin) {
            New-NetFirewallRule -DisplayName $FirewallRuleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private | Out-Null
            Write-Ok "firewall rule added"
        } else {
            Write-Warn2 "not running as Admin — re-run this script as Administrator to add the rule, OR run manually:"
            Write-Host "  New-NetFirewallRule -DisplayName '$FirewallRuleName' -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow -Profile Private"
        }
    }
}

# ---------- 5. PM2 autostart ----------
Write-Say "PM2 autostart"
$pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
if (-not $pm2) {
    if (Ask-Yes "PM2 not found. Install pm2 + pm2-windows-startup globally?" $true) {
        npm install -g pm2 pm2-windows-startup
        Write-Ok "PM2 installed"
        $pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
    }
}

if ($pm2) {
    if (Ask-Yes "Register agent.js with PM2 and enable autostart on logon?" $true) {
        Push-Location $ScriptDir
        try {
            # Clear any stale registration
            pm2 delete $ServiceName 2>$null
            pm2 start agent.js --name $ServiceName
            pm2 save
            try { pm2-startup install } catch { Write-Warn2 "pm2-startup install failed: $_" }
            pm2 save
            Write-Ok "agent registered with PM2"
        } finally {
            Pop-Location
        }
    }
} else {
    Write-Warn2 "PM2 not installed — to autostart on logon, install PM2 manually and run:"
    Write-Host "    pm2 start agent.js --name $ServiceName"
    Write-Host "    pm2 save"
    Write-Host "    pm2-startup install"
}

# ---------- Done ----------
Write-Host ""
Write-Ok "Setup complete."
Write-Host ""
Write-Host "Agent URL:    http://0.0.0.0:$port"
Write-Host "Config file:  $ConfigFile"
Write-Host ""
Write-Host "Quick test (from this machine):"
Write-Host "  Invoke-RestMethod http://localhost:$port/health -Headers @{ 'X-Auth-Token' = '$secret' }"
Write-Host ""
Write-Host "Useful commands:"
Write-Host "  pm2 status"
Write-Host "  pm2 logs $ServiceName"
Write-Host "  pm2 restart $ServiceName"
Write-Host "  .\setup.ps1 -Uninstall"
