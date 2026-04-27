# Pi Setup — Detailed

This walks through the Pi side of Command Deck. If you ran `setup.sh` and it finished cleanly, you can skip to the [Verify](#verify) section.

## Prerequisites

- Raspberry Pi 4 or 5 with **Pi OS Bookworm** (Desktop edition — Lite won't work without extra steps for the kiosk display)
- HDMI touchscreen plugged into the Pi (HDMI for video, USB for touch)
- Pi powered on, connected to your LAN, and SSH enabled
- Your Pi's IP address (find it via `hostname -I` on the Pi or your router's DHCP table)
- A user account on the Pi (no longer the default `pi` user — you set one during first boot)

## What the bootstrap script does

`pi/setup.sh` is interactive and idempotent. Steps:

1. Verifies Node.js 18+ is installed; offers to install Node.js 20 from NodeSource if not
2. Runs `npm install` in the `pi/` directory
3. Generates a 64-character shared secret (or accepts your own)
4. Writes `pi/config.json` with shared secret, agent IP, weather coordinates
5. Optionally installs a systemd service (`/etc/systemd/system/command-deck.service`)
6. Optionally adds Chromium kiosk autostart to the relevant compositor config
7. Optionally enables desktop autologin via `raspi-config`

Re-running the script is safe; it asks before overwriting anything.

To uninstall the service and autostart entries (without deleting source files):

```bash
./setup.sh --uninstall
```

## Manual setup

If you'd rather do it by hand, or if the script fails at some step:

### 1. Install Node.js 20

```bash
sudo apt update
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node --version  # should print v20.x
```

### 2. Install the project

```bash
cd ~
git clone https://github.com/yourname/command-deck.git
cd command-deck/pi
npm install
```

### 3. Configure

```bash
cp config.example.json config.json
nano config.json
```

Required fields to edit:
- `agentUrl` → `http://<your-laptop-ip>:5000`
- `sharedSecret` → a string of at least 16 characters (generate one with `openssl rand -hex 32` or use the secret your Windows agent generated)

Other fields you'll likely want to update:
- `weather.latitude`, `weather.longitude` → your coordinates (or set `enabled: false` to skip the weather pill)
- `instances` → list your work environments
- `tiles` → start with the example tiles, customize from there

See [CONFIG_REFERENCE.md](CONFIG_REFERENCE.md) for every field.

### 4. Test manually

```bash
node server.js
```

You should see:
```
Command Deck server listening on http://0.0.0.0:3000
Agent target: http://192.168.0.42:5000
Active instance: example-dev
```

From your laptop browser, visit `http://<pi-ip>:3000`. The dashboard loads (with all status tiles showing `?` until the agent is also up). Press `Ctrl+C` to stop.

### 5. Systemd service (autostart on boot)

Create `/etc/systemd/system/command-deck.service`:

```bash
sudo tee /etc/systemd/system/command-deck.service > /dev/null <<EOF
[Unit]
Description=Command Deck dashboard server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$HOME/command-deck/pi
ExecStart=/usr/bin/node $HOME/command-deck/pi/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now command-deck
sudo systemctl status command-deck
```

### 6. Chromium kiosk autostart

Pi OS Bookworm ships with one of three desktop compositors depending on when you flashed the SD card. Find yours:

```bash
sudo raspi-config nonint get_wayland 2>/dev/null   # might error on older raspi-config
ps -eo comm | grep -E '^(wayfire|labwc|openbox)' | sort -u
```

The output of the second command tells you which compositor is running.

**Labwc** (newer Bookworm default):

```bash
mkdir -p ~/.config/labwc
cat >> ~/.config/labwc/autostart <<'EOF'
chromium-browser --kiosk --noerrdialogs --disable-infobars --no-first-run --start-maximized --password-store=basic --disable-features=TranslateUI --disable-session-crashed-bubble --disable-component-update --check-for-update-interval=31536000 --app=http://localhost:3000 &
swayidle -w timeout 0 'true' &
unclutter -idle 0.5 &
EOF
```

**Wayfire** (older Bookworm default):

```bash
cat >> ~/.config/wayfire.ini <<'EOF'

[autostart]
cdkiosk = chromium-browser --kiosk --noerrdialogs --disable-infobars --no-first-run --start-maximized --password-store=basic --app=http://localhost:3000
EOF
```

**LXDE** (X11, older Pi OS):

```bash
mkdir -p ~/.config/lxsession/LXDE-pi
cat >> ~/.config/lxsession/LXDE-pi/autostart <<'EOF'
@chromium-browser --kiosk --noerrdialogs --disable-infobars --no-first-run --start-maximized --password-store=basic --app=http://localhost:3000
EOF
```

Optional but recommended:

```bash
sudo apt install -y unclutter   # hides the mouse cursor when idle
```

### 7. Enable desktop autologin

```bash
sudo raspi-config
```

Navigate: `1 System Options` → `S5 Boot / Auto Login` → `B4 Desktop Autologin`. Tab to `<Finish>` and reboot.

Without autologin, the kiosk won't start until you log into the desktop manually — fine for development, not for a "always-on" dashboard.

## Verify

After reboot, the dashboard should appear full-screen on the touchscreen.

If it doesn't:

```bash
sudo systemctl status command-deck     # is the server running?
journalctl -u command-deck -n 30       # any errors?
ps aux | grep chromium                 # did Chromium launch?
curl http://localhost:3000             # does the page respond?
```

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common issues.

## Updating

When you pull a new version of the repo:

```bash
cd ~/command-deck
git pull
cd pi
npm install                              # if dependencies changed
sudo systemctl restart command-deck
```

`config.json` is not tracked in git, so your settings survive updates.

## Adding the Pi to a UPS or smart plug

Optional but worth knowing — if you want the dashboard to come back automatically after a power outage, the Pi must be on a power source that delivers consistent voltage on restoration. Cheap smart plugs that "remember last state" work well. Pis recover from power loss reasonably well thanks to the journaled filesystem, but ungraceful shutdowns can corrupt SD cards over time. A small UPS or `dpkg-reconfigure --priority=low unattended-upgrades` handles most of this.
