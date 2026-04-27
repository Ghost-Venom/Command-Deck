# Agent Setup — Detailed

This walks through the Windows side. If you ran `setup.ps1` and it finished cleanly, skip to [Verify](#verify).

## Prerequisites

- Windows 10 or 11
- Node.js 18+ ([install from nodejs.org](https://nodejs.org); LTS is fine)
- Same shared secret you set on the Pi
- Pi already up and running (or at least, you know what IP it'll be on)

## What the bootstrap script does

`agent/setup.ps1` is interactive. It:

1. Verifies Node.js is installed
2. Runs `npm install` in the agent directory
3. Generates a 64-character shared secret (or accepts your own)
4. Writes `agent/config.json` with port, secret, Outlook integration setting
5. Auto-detects classic Outlook if you enabled the integration
6. Optionally adds a Windows Firewall rule (requires Admin to write the rule)
7. Optionally installs PM2 + pm2-windows-startup and registers the agent for autostart

To uninstall (without deleting source files):

```powershell
.\setup.ps1 -Uninstall
```

## Manual setup

### 1. Install Node.js

Download the LTS installer from [nodejs.org](https://nodejs.org). Default options are fine. Open a fresh PowerShell window after install and verify:

```powershell
node --version
npm --version
```

### 2. Install the project

```powershell
cd C:\
git clone https://github.com/yourname/command-deck.git
cd command-deck\agent
npm install
```

### 3. Configure

```powershell
copy config.example.json config.json
notepad config.json
```

Required:
- `sharedSecret` → must exactly match the Pi's `sharedSecret`. At least 16 chars.

Important:
- `outlook.enabled` → `true` if you have **classic Outlook** (not "new Outlook"). Set to `false` otherwise; the unread-count and meeting-pill features will simply return null
- `outlook.exePath` → path to classic OUTLOOK.EXE. Find yours with:
  ```powershell
  Get-ChildItem 'C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE','C:\Program Files (x86)\Microsoft Office\root\Office16\OUTLOOK.EXE' -ErrorAction SilentlyContinue | Select-Object FullName
  ```

See [CONFIG_REFERENCE.md](CONFIG_REFERENCE.md) for all fields.

### 4. Test manually

Run the agent in the foreground:

```powershell
node agent.js
```

Expected output:

```
Command Deck agent listening on http://0.0.0.0:5000
Outlook integration: enabled
Outlook exe: C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE
Available commands: launch_outlook, launch_teams, open_url, lock_workstation, noop_v2
```

Test it from another window:

```powershell
$secret = "PASTE_YOUR_SECRET_HERE"
Invoke-RestMethod http://localhost:5000/health -Headers @{ "X-Auth-Token" = $secret }
```

You should see `ok = True`. Press Ctrl+C in the agent window to stop.

### 5. Open the firewall

In an Admin PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Command Deck Agent" -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow -Profile Private
```

Profile `Private` means the rule only applies on networks Windows considers private (your home Wi-Fi). On a public network, the agent won't be reachable — **this is intentional**.

If your home Wi-Fi shows as "Public" in Windows, fix it:

```powershell
Get-NetConnectionProfile                # see all current networks
Set-NetConnectionProfile -Name "YourSSID" -NetworkCategory Private
```

### 6. PM2 autostart

PM2 keeps the agent running and relaunches it on logon. **Run as your normal user, NOT as Administrator** — PM2 inherits the elevation level of the shell that starts it, and the agent needs to run at the same level as Outlook (which is non-elevated).

```powershell
npm install -g pm2 pm2-windows-startup
cd C:\command-deck\agent
pm2 start agent.js --name command-deck-agent
pm2 save
pm2-startup install
pm2 save                                  # save again after pm2-startup
```

Useful PM2 commands:

```powershell
pm2 status                                # is it running?
pm2 logs command-deck-agent               # tail logs
pm2 logs command-deck-agent --err         # only stderr
pm2 logs command-deck-agent --lines 50    # last 50 lines
pm2 restart command-deck-agent            # after editing config.json
pm2 flush command-deck-agent              # clear log buffers
pm2 describe command-deck-agent           # see exact paths PM2 is using
```

### 7. Reboot test

Reboot the laptop. After login, wait ~10-20 seconds for PM2 to launch. Then:

```powershell
pm2 status
```

Should show `command-deck-agent` as `online`. If not, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Verify (Pi ↔ agent)

From the Pi, with both sides running:

```bash
curl -v --max-time 5 -H "X-Auth-Token: YOUR_SECRET" http://YOUR_LAPTOP_IP:5000/health
```

Expected: `200 OK` with `{"ok":true}`.

Common failure modes:
- **`401 Unauthorized`** → secret mismatch. Compare `agent/config.json` and `pi/config.json`.
- **`Connection refused`** → agent isn't listening. Check `pm2 status`.
- **Times out** → firewall blocking, or the Pi is on the wrong network.
- **`Failed to parse URL`** → `agentUrl` in Pi config is missing the `http://` prefix.

## Adding new commands

Edit `agent/agent.js`, find the `commands` object, add an entry:

```javascript
const commands = {
    // ...existing handlers...

    open_calculator: () => runShell('start calc'),

    take_screenshot: () => runShell('start ms-screenclip:'),

    flush_dns: () => runShell('ipconfig /flushdns'),

    custom_powershell: () => runPS('Get-Process -Name MyApp | Stop-Process')
};
```

Then `pm2 restart command-deck-agent`. The Pi-side tile config references commands by name; see [ADDING_TILES.md](ADDING_TILES.md).

Whatever you whitelist here is what the Pi can fire. The agent never accepts arbitrary shell input from the Pi — only named commands map to handlers.

## Adding new status fields

Edit `agent/agent.js`, find `buildStatus()`, add to the status object:

```javascript
async function buildStatus() {
    // ...
    try {
        status.diskFreeGb = await getDiskFree();
    } catch (err) {
        status.diskFreeGb = null;
    }
    // ...
}

async function getDiskFree() {
    const out = await runPS('[math]::Round((Get-PSDrive C).Free / 1GB)');
    return parseInt(out, 10);
}
```

Then in `pi/config.json`, set a tile's `statusKey` to `"diskFreeGb"` to display it.

## Updating

```powershell
cd C:\command-deck
git pull
cd agent
npm install                               # if dependencies changed
pm2 restart command-deck-agent
```

`config.json` is not tracked in git, so your settings survive updates.
