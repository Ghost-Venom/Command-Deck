# Troubleshooting

Real problems people hit, with the fixes that work.

## "Not connected" — dashboard can't reach agent

The most common issue. Diagnose with this single curl from the Pi:

```bash
SECRET=$(grep sharedSecret ~/command-deck/pi/config.json | cut -d'"' -f4)
AGENT=$(grep agentUrl ~/command-deck/pi/config.json | cut -d'"' -f4)
curl -v --max-time 5 -H "X-Auth-Token: $SECRET" $AGENT/health
```

Outcomes:

### `Connection refused`

Agent isn't running. On the laptop:

```powershell
pm2 status
pm2 logs command-deck-agent --lines 20
```

If the process isn't there, see "Agent won't start" below.

### Times out (no response)

Network or firewall. Check:

```powershell
# 1. Is the agent actually listening on the network interface?
netstat -ano | findstr :5000
```

Should show `0.0.0.0:5000`. If it shows `127.0.0.1:5000`, the agent is bound to localhost only — that's a code issue, not config.

```powershell
# 2. Is the firewall rule there and applicable?
Get-NetFirewallRule -DisplayName "Command Deck Agent" | Format-List DisplayName,Enabled,Profile
Get-NetConnectionProfile | Format-List Name,NetworkCategory
```

If the rule is `Profile: Private` but your home network shows `NetworkCategory: Public`, fix it:

```powershell
Set-NetConnectionProfile -Name "YourSSID" -NetworkCategory Private
```

### `401 Unauthorized`

Secret mismatch. Compare:

```bash
grep sharedSecret ~/command-deck/pi/config.json
```

```powershell
type C:\command-deck\agent\config.json | findstr sharedSecret
```

The values must be identical (no leading/trailing whitespace, no smart quotes from copy-paste). Update one to match the other and restart that side.

### `Failed to parse URL from <something>:5000/status`

Pi config's `agentUrl` is missing `http://`. Edit `~/command-deck/pi/config.json`:

```json
"agentUrl": "http://192.168.0.42:5000"
```

(Not `"192.168.0.42:5000"`.)

### `200 OK` from curl but dashboard still says offline

The Pi server is running but Chromium can't load the page, or it cached an error. Try:

```bash
sudo systemctl restart command-deck
sudo loginctl terminate-user $USER   # restarts the desktop session, relaunching kiosk
```

---

## Agent won't start

### `FATAL: set sharedSecret in config.json before starting`

Agent's `config.json` still has the placeholder `"CHANGE_ME"`. Replace with your real secret.

If you swear you set it, you might be editing a different `config.json` than the one the agent loads. Check what PM2 thinks:

```powershell
pm2 describe command-deck-agent | findstr -i "script cwd"
```

Edit the config in *that* directory.

### `errored` status with no obvious error

Run the agent manually to see what it crashes on:

```powershell
pm2 stop command-deck-agent
cd C:\command-deck\agent
node agent.js
```

Most likely cause: invalid JSON in `config.json`. Validate:

```powershell
Get-Content config.json | ConvertFrom-Json
```

If it errors, that's your problem. Check for: missing commas, missing closing braces, trailing commas, smart quotes.

### Restart count keeps climbing in `pm2 status`

Agent is crashing in a loop. `pm2 logs command-deck-agent --err` will show why. Most common: COM error spam (see Outlook section below).

---

## Outlook unread always shows `?` or `null`

Run through these in order:

### 1. Is the integration enabled?

In `agent/config.json`:

```json
"outlook": { "enabled": true }
```

(Default in `config.example.json` is `false`.)

### 2. Is classic Outlook running?

```powershell
Get-Process OUTLOOK -ErrorAction SilentlyContinue
```

If nothing returns, classic Outlook isn't running. Outlook COM only works when the app is open.

If `Get-Process olk` returns something but `Get-Process OUTLOOK` is empty, you have **new Outlook** running, not classic. New Outlook has no COM interface. Either:

- Toggle "New Outlook" off in the top-right of the Outlook window
- Launch classic Outlook directly (its exe is at `C:\Program Files\Microsoft Office\root\Office16\OUTLOOK.EXE` typically)
- Set `outlook.enabled: false` and skip the unread feature for now

### 3. COM `Server execution failed (0x80080005)`

Elevation mismatch. The shell running PM2 (or the agent) is at a different elevation level than Outlook. Outlook's COM server is in your interactive session, non-elevated.

Fix: kill PM2 and restart it from a non-elevated PowerShell:

```powershell
pm2 kill                  # nukes the PM2 daemon entirely
# Open a new, non-elevated PowerShell
cd C:\command-deck\agent
pm2 start agent.js --name command-deck-agent
pm2 save
pm2-startup install
```

Verify with `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole("Administrator")` — should return `False`.

### 4. COM works in PowerShell but agent gets null

Test the agent's PowerShell call directly:

```powershell
powershell -NoProfile -NonInteractive -Command "try { $ol = New-Object -ComObject Outlook.Application; $inbox = $ol.GetNamespace('MAPI').GetDefaultFolder(6); Write-Output $inbox.UnReadItemCount } catch { Write-Output ('ERROR: ' + $_.Exception.Message) }"
```

Whatever this prints is what the agent sees. If it prints an error, fix that error. If it prints a number, but the agent gets null — there's a mismatch between the agent.js you're editing and the one PM2 is running. See "Editing the wrong file" below.

---

## Editing the wrong file

Common in this codebase because of accumulating clones in different directories. To find every config.json in the project:

```powershell
Get-ChildItem C:\ -Recurse -Filter "config.json" -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match "command-deck|dashboard" } | Select-Object FullName
```

Then check what PM2 actually runs:

```powershell
pm2 describe command-deck-agent | findstr -i "script cwd"
```

The cleanest fix:

```powershell
pm2 stop command-deck-agent
pm2 delete command-deck-agent
cd C:\command-deck\agent     # the canonical location
pm2 start agent.js --name command-deck-agent
pm2 save
```

PM2 now uses the directory you `cd`'d into.

---

## Cortex XDR / CrowdStrike / endpoint protection flags the agent

Symptoms: agent process gets killed, alerts in your security console, IT calls you.

What's happening: Node spawning PowerShell that talks to Outlook COM matches several "suspicious chain" detection rules. The classic LOLBin pattern (Living Off the Land Binary).

Workarounds, in order of escalation:

1. **Disable Outlook integration** (`outlook.enabled: false`) — eliminates the PowerShell-spawning. Lose the unread/meeting features. Other tiles still work.
2. **Talk to your security team.** Provide them the source — it's open. The detection isn't catching malware, it's pattern-matching a behavior class. Many EDR products allow per-process exceptions.
3. **Switch to Microsoft Graph API** (planned for a future release). Talks to Exchange Online over HTTPS, no PowerShell, no COM. Cortex doesn't flag plain HTTPS to graph.microsoft.com.

If your work computer is managed and you can't get an exception, the realistic answer is: don't run this on the work computer. Run it on a personal machine that has access to your work email (e.g., Outlook desktop logged into your work account on a personal Windows install). The agent doesn't care which machine it's on.

---

## Pi-side issues

### Dashboard service keeps restarting

```bash
journalctl -u command-deck -n 50
```

Most common: a syntax error in `config.json`. Validate:

```bash
node -e "JSON.parse(require('fs').readFileSync('/home/$USER/command-deck/pi/config.json'))"
```

If that errors, fix the JSON.

Less common: a paste artifact in `server.js`. If the file mysteriously has thousands of lines or random English text in it, replace it with a fresh copy from the repo:

```bash
cd ~/command-deck
git checkout HEAD -- pi/server.js
sudo systemctl restart command-deck
```

### Kiosk doesn't appear after reboot

```bash
ps aux | grep chromium                   # is Chromium running?
echo $XDG_CURRENT_DESKTOP                # which compositor (run from desktop session, not SSH)
```

If Chromium isn't running, your autostart isn't firing. Check:

```bash
ls -la ~/.config/labwc/autostart ~/.config/wayfire.ini ~/.config/lxsession/LXDE-pi/autostart 2>/dev/null
```

Whichever exists, `cat` it and confirm there's a Chromium line. If the wrong compositor's autostart is configured, fix it (see PI_SETUP.md section 6).

### "The site can't be reached" on the touchscreen

Pi server isn't running, or kiosk URL is wrong.

```bash
sudo systemctl status command-deck       # should say active (running)
curl http://localhost:3000               # should return HTML
```

If the systemd service is failing, see "Dashboard service keeps restarting" above.

### Touchscreen taps land in the wrong place

That's a touch calibration issue, not a Command Deck issue. For Wayland (labwc/wayfire), check the touchscreen vendor's docs. For X11, `xinput-calibrator` is the classic tool.

### Asking for a keyring password on every boot

Add `--password-store=basic` to your Chromium autostart command. The setup script does this; if you set it up manually, you may have missed it. Edit `~/.config/labwc/autostart` (or equivalent) and add the flag.

---

## Everything pasted on one line in PowerShell

If you've been pasting multi-line scripts into PowerShell and seeing each line execute separately (or worse, parts mangled into hyperlinks), that's a terminal paste-handling issue.

Workarounds:

- Type commands instead of pasting when they're short
- Save the script to a `.ps1` file and run that file
- For multi-line snippets, paste into a script block: open a new PowerShell window, type a single `>>` continuation prompt, then paste

Smart-quote substitution (terminals replacing `"` with `"` or `"`) breaks JSON and PowerShell strings. Watch for it.

---

## "Why did my changes disappear?"

You probably ran `setup.sh` or `setup.ps1` again, or extracted a tarball over your edits, and one of them overwrote `config.json`.

To prevent this: `config.json` is in `.gitignore` so `git pull` won't touch it. But if you re-run `setup.sh`, it asks before overwriting — answer No.

If you've lost edits, check for backups: setup scripts don't currently make backups but `git stash` of any tracked-file changes is automatic when you `git pull`.

---

## Still stuck?

Open an issue with:

- What you were doing (the request, not just the symptom)
- Output of `pm2 logs command-deck-agent --lines 50`
- Output of `journalctl -u command-deck -n 50`
- Your `config.json` files (with secrets redacted!)
- Pi OS version (`cat /etc/os-release`)
- Windows version
