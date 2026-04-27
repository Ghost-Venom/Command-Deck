# Command Deck

A touchscreen command deck for your desk, powered by a Raspberry Pi and a tiny agent on your work computer.

Tap tiles to launch apps, open URLs, run scripts. Show live counts (Outlook unread). Pop a full-screen alert before meetings start. Switch context between client/instance with one tap. Stay aware of weather, time, and your next meeting at a glance.

> **Status:** v0.1.0 — first public release. Works well, but rough edges remain. See [Limitations](#limitations).

## What it looks like

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ▣ COMMAND DECK   62°  ▷ in 23min · Standup   INSTANCE Dev ▾   ●live  3:47 PM │
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐                              │
│ │ Outlook │ │  Teams  │ │   Lock  │ │  Group  │                              │
│ │   12    │ │   ↗     │ │   ↗     │ │    ⊞    │                              │
│ ├─────────┤ ├─────────┤ ├─────────┤ ├─────────┤                              │
│ │   ...   │ │   ...   │ │   ...   │ │   ...   │                              │
│ └─────────┘ └─────────┘ └─────────┘ └─────────┘                              │
│                          ...                                                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

## What it does

- Touch tile grid (4×3) that fires actions on your work computer
- Live status badges on tiles (Outlook unread count, more coming)
- Group tiles that open a modal of sub-tiles (e.g., one "Acme Corp" tile that opens Dev/Test/Prod environments)
- Active-instance picker — module tiles like "Flow Designer" or "Background Scripts" target whichever instance you've selected
- Top-bar pills: current weather, next meeting countdown, connection status, clock
- Full-screen alert 3 minutes before meetings, with live `M:SS` countdown
- Auto-blur to a low-power "Agent Offline" overlay when the work computer is unreachable

## How it works

```
┌─────────────┐   HTTP    ┌──────────────┐   COM/exec    ┌────────────┐
│   Pi 4/5    │  ←─────→  │   Windows    │  ←─────────→  │  Outlook,  │
│  + 7" touch │  LAN poll │     agent    │               │  Teams,    │
│             │           │  (Node+PM2)  │               │  browser…  │
│   Chromium  │           │              │               │            │
│   kiosk     │           │              │               │            │
└─────────────┘           └──────────────┘               └────────────┘
```

The Pi runs a Node server that hosts a static dashboard in Chromium kiosk mode. A small Node agent runs on your work machine, exposing `/status` (read-only) and `/command` (whitelisted ops) over HTTP on your LAN. The Pi polls the agent every 30 seconds for status data; tile taps post commands back. A shared secret protects the agent.

## Hardware needed

- **Pi:** any Raspberry Pi capable of running Pi OS Bookworm (Pi 4 or 5 strongly recommended)
- **Touchscreen:** any HDMI display with USB touch input (HID class). Tested on a 7" 1024×600 panel
- **Work computer:** Windows 10/11 (Linux + macOS support not in scope yet — agent uses PowerShell)
- **Network:** both devices on the same LAN. Static IP or DHCP reservation for the work computer is recommended

## Quick start

> Estimated time: 30 minutes if everything goes smoothly.

### On the Pi

```bash
git clone https://github.com/Ghost-Venom/command-deck.git
cd command-deck/pi
./setup.sh
```

The script will:
1. Install Node.js if missing
2. Generate a shared secret and write `config.json`
3. Install npm dependencies
4. Optionally install a systemd service to autostart
5. Optionally configure Chromium kiosk autostart for your compositor

Save the shared secret it shows you — you'll paste it on the Windows side.

### On the Windows machine

Open PowerShell (no need for Admin yet — script will tell you if it needs elevation):

```powershell
git clone https://github.com/Ghost-Venom/command-deck.git
cd command-deck\agent
.\setup.ps1
```

The script will:
1. Verify Node.js
2. Prompt for the same shared secret you used on the Pi
3. Detect classic Outlook if installed (optional)
4. Optionally open Windows Firewall on port 5000
5. Optionally register the agent with PM2 for autostart on logon

### Verify

From the Pi (SSH or terminal):

```bash
sudo systemctl status command-deck   # should be active (running)
```

From a browser, visit `http://<pi-ip>:3000`. You should see the dashboard.

If the connection dot is red ("not connected"), see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## Documentation

- **[docs/PI_SETUP.md](docs/PI_SETUP.md)** — full Pi setup with manual options
- **[docs/AGENT_SETUP.md](docs/AGENT_SETUP.md)** — full Windows setup
- **[docs/CONFIG_REFERENCE.md](docs/CONFIG_REFERENCE.md)** — every config field explained
- **[docs/ADDING_TILES.md](docs/ADDING_TILES.md)** — adding tiles, instances, custom commands
- **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — common problems and fixes

## Limitations

This is a v0.1.0 with known rough edges:

- **Outlook unread / next-meeting requires *classic* Outlook**, not "new Outlook." New Outlook has no COM interface. Microsoft Graph API support is planned for a future release
- **No Teams unread count.** No reliable local API; would require Graph
- **Windows-only agent.** Outlook COM is the integration that drives most value, and that's a Windows-only API. macOS/Linux agents would be a future direction
- **No HTTPS between Pi and agent.** Same-LAN HTTP with shared-secret auth. Don't run this on a network you don't trust
- **EDR / managed-device caveats.** Some endpoint protection products (Cortex XDR, CrowdStrike, etc.) will flag Node spawning PowerShell to read Outlook. Discuss with your IT before deploying on a managed machine

## Roadmap

Things in the queue, no committed timelines:

- Microsoft Graph integration (works around new Outlook + adds Teams DND/presence/unread)
- Teams DND toggle tile
- More built-in tile types (countdown timers, system info, Pomodoro)
- Linux agent variant
- Theme presets

## Contributing

PRs welcome. The repo is small enough that issues are the right place to start any non-trivial change.

## License

MIT — see [LICENSE](LICENSE).
