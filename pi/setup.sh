#!/usr/bin/env bash
# Command Deck — Pi setup script
#
# Interactive bootstrap: installs Node.js if needed, generates config.json,
# installs the systemd service, and configures kiosk autostart.
#
# Usage:
#   ./setup.sh             # interactive
#   ./setup.sh --uninstall # remove service + autostart (does NOT delete files)
#
# Safe to re-run; idempotent. Will prompt before any destructive step.

set -euo pipefail

# ---------- Colors ----------
if [ -t 1 ]; then
    BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
    CYAN=$'\033[36m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'
else
    BOLD=""; DIM=""; RESET=""; CYAN=""; GREEN=""; YELLOW=""; RED=""
fi

say()    { echo "${CYAN}${BOLD}==>${RESET} $*"; }
ok()     { echo "${GREEN}✓${RESET} $*"; }
warn()   { echo "${YELLOW}!${RESET} $*"; }
err()    { echo "${RED}✗${RESET} $*" >&2; }
prompt() { local var="$1"; local msg="$2"; local default="${3:-}"; local ans
    if [ -n "$default" ]; then
        read -r -p "$msg [$default]: " ans </dev/tty
        printf -v "$var" '%s' "${ans:-$default}"
    else
        read -r -p "$msg: " ans </dev/tty
        printf -v "$var" '%s' "$ans"
    fi
}
confirm() { local msg="$1"; local default="${2:-n}"; local ans
    local hint="[y/N]"; [ "$default" = "y" ] && hint="[Y/n]"
    read -r -p "$msg $hint " ans </dev/tty
    ans="${ans:-$default}"
    [[ "$ans" =~ ^[Yy] ]]
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="command-deck"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"

# ---------- Uninstall mode ----------
if [ "${1:-}" = "--uninstall" ]; then
    say "Uninstalling Command Deck (files in $SCRIPT_DIR will be left in place)"
    if [ -f "$SERVICE_PATH" ]; then
        sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true
        sudo systemctl disable "$SERVICE_NAME" 2>/dev/null || true
        sudo rm "$SERVICE_PATH"
        sudo systemctl daemon-reload
        ok "removed systemd service"
    else
        warn "no systemd service installed"
    fi
    if [ -f "$HOME/.config/labwc/autostart" ] && grep -q "command-deck-kiosk" "$HOME/.config/labwc/autostart"; then
        sed -i '/# command-deck-kiosk start/,/# command-deck-kiosk end/d' "$HOME/.config/labwc/autostart"
        ok "removed labwc autostart entry"
    fi
    if [ -f "$HOME/.config/wayfire.ini" ] && grep -q "command-deck-kiosk" "$HOME/.config/wayfire.ini"; then
        sed -i '/^cdkiosk = /d' "$HOME/.config/wayfire.ini"
        ok "removed wayfire autostart entry"
    fi
    ok "uninstalled. Files in $SCRIPT_DIR preserved; delete manually if desired."
    exit 0
fi

# ---------- Banner ----------
echo
echo "${BOLD}Command Deck — Pi Setup${RESET}"
echo "${DIM}https://github.com/yourname/command-deck${RESET}"
echo

# ---------- 1. Node.js ----------
say "Checking Node.js"
if command -v node >/dev/null 2>&1; then
    NODE_VER=$(node --version)
    ok "Node found: $NODE_VER"
else
    warn "Node.js not installed"
    if confirm "Install Node.js 20 from NodeSource?" y; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
        ok "Node.js installed: $(node --version)"
    else
        err "Node.js is required. Install it manually and re-run this script."
        exit 1
    fi
fi

# ---------- 2. npm install ----------
say "Installing npm dependencies"
cd "$SCRIPT_DIR"
npm install --silent --no-fund --no-audit
ok "dependencies installed"

# ---------- 3. config.json ----------
say "Configuration"
CONFIG_FILE="$SCRIPT_DIR/config.json"
EXAMPLE_FILE="$SCRIPT_DIR/config.example.json"

if [ -f "$CONFIG_FILE" ]; then
    if confirm "config.json already exists. Re-run config wizard? (will overwrite)" n; then
        rm "$CONFIG_FILE"
    else
        warn "skipping config wizard"
    fi
fi

if [ ! -f "$CONFIG_FILE" ]; then
    cp "$EXAMPLE_FILE" "$CONFIG_FILE"

    # Generate or accept a secret
    GEN_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
    echo
    echo "Shared secret (you'll paste this same value into the Windows agent):"
    echo "  $GEN_SECRET"
    echo
    if confirm "Use this generated secret?" y; then
        SECRET="$GEN_SECRET"
    else
        prompt SECRET "Enter your own secret (min 16 chars)"
    fi

    prompt AGENT_IP "Windows agent IP address" ""
    prompt AGENT_PORT "Windows agent port" "5000"

    echo
    echo "Weather (Open-Meteo, no API key needed)."
    if confirm "Enable weather pill?" y; then
        prompt LAT "Latitude (e.g. 38.9989)" ""
        prompt LON "Longitude (e.g. -84.6266)" ""
        prompt UNIT "Temperature unit (fahrenheit/celsius)" "fahrenheit"
        WEATHER_ENABLED="true"
    else
        WEATHER_ENABLED="false"
        LAT="0"; LON="0"; UNIT="fahrenheit"
    fi

    # Patch config.json with the values. We use node so we don't depend on jq.
    node <<EOF
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('$CONFIG_FILE', 'utf8'));
c.sharedSecret = '$SECRET';
c.agentUrl = 'http://$AGENT_IP:$AGENT_PORT';
c.weather = {
    enabled: ${WEATHER_ENABLED},
    latitude: parseFloat('$LAT') || 0,
    longitude: parseFloat('$LON') || 0,
    unit: '$UNIT'
};
fs.writeFileSync('$CONFIG_FILE', JSON.stringify(c, null, 4));
EOF
    ok "config.json written"
fi

# ---------- 4. systemd service ----------
say "Systemd service"
if confirm "Install systemd service to autostart on boot?" y; then
    sudo tee "$SERVICE_PATH" > /dev/null <<EOF
[Unit]
Description=Command Deck dashboard server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=/usr/bin/node $SCRIPT_DIR/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    sudo systemctl daemon-reload
    sudo systemctl enable --now "$SERVICE_NAME"
    sleep 2
    if sudo systemctl is-active --quiet "$SERVICE_NAME"; then
        ok "service running"
    else
        err "service failed to start. Check: sudo journalctl -u $SERVICE_NAME -n 50"
    fi
else
    warn "skipping systemd setup. Run manually: node server.js"
fi

# ---------- 5. Kiosk autostart ----------
say "Kiosk autostart"
KIOSK_URL="http://localhost:$(node -p "JSON.parse(require('fs').readFileSync('$CONFIG_FILE')).port||3000")"
KIOSK_CMD="chromium-browser --kiosk --noerrdialogs --disable-infobars --no-first-run --start-maximized --password-store=basic --disable-features=TranslateUI --disable-session-crashed-bubble --disable-component-update --check-for-update-interval=31536000 --app=$KIOSK_URL"

# Detect compositor
COMPOSITOR=""
if [ -d "$HOME/.config/labwc" ] || command -v labwc >/dev/null 2>&1; then
    COMPOSITOR="labwc"
elif [ -f "$HOME/.config/wayfire.ini" ] || command -v wayfire >/dev/null 2>&1; then
    COMPOSITOR="wayfire"
elif [ -d "$HOME/.config/lxsession/LXDE-pi" ]; then
    COMPOSITOR="lxde"
fi

if [ -z "$COMPOSITOR" ]; then
    warn "could not detect desktop compositor (labwc/wayfire/lxde)"
    warn "you'll need to add the kiosk command to your desktop's autostart manually:"
    echo "  $KIOSK_CMD"
elif confirm "Install Chromium kiosk autostart for $COMPOSITOR?" y; then
    case "$COMPOSITOR" in
        labwc)
            mkdir -p "$HOME/.config/labwc"
            target_file="$HOME/.config/labwc/autostart"
            touch "$target_file"
            sed -i '/# command-deck-kiosk start/,/# command-deck-kiosk end/d' "$target_file"
            cat >> "$target_file" <<EOF
# command-deck-kiosk start
$KIOSK_CMD &
swayidle -w timeout 0 'true' &
unclutter -idle 0.5 &
# command-deck-kiosk end
EOF
            ok "wrote to ~/.config/labwc/autostart"
            ;;
        wayfire)
            target_file="$HOME/.config/wayfire.ini"
            if ! grep -q "^\[autostart\]" "$target_file"; then
                echo -e "\n[autostart]" >> "$target_file"
            fi
            sed -i '/^cdkiosk = /d' "$target_file"
            sed -i "/^\[autostart\]/a cdkiosk = $KIOSK_CMD" "$target_file"
            ok "wrote to ~/.config/wayfire.ini"
            ;;
        lxde)
            mkdir -p "$HOME/.config/lxsession/LXDE-pi"
            target_file="$HOME/.config/lxsession/LXDE-pi/autostart"
            touch "$target_file"
            grep -v "command-deck-kiosk" "$target_file" > "${target_file}.tmp" || true
            mv "${target_file}.tmp" "$target_file"
            echo "@$KIOSK_CMD # command-deck-kiosk" >> "$target_file"
            ok "wrote to ~/.config/lxsession/LXDE-pi/autostart"
            ;;
    esac

    # Optional: install unclutter for cursor-hide
    if ! command -v unclutter >/dev/null 2>&1; then
        if confirm "Install 'unclutter' to hide the mouse cursor?" y; then
            sudo apt-get install -y unclutter
        fi
    fi

    # Confirm autologin
    if command -v raspi-config >/dev/null 2>&1; then
        AUTOLOGIN=$(sudo raspi-config nonint get_autologin || echo "1")
        if [ "$AUTOLOGIN" != "0" ]; then
            warn "Desktop autologin is OFF — kiosk won't start until you log in"
            if confirm "Enable desktop autologin?" y; then
                sudo raspi-config nonint do_boot_behaviour B4 || true
                ok "autologin enabled"
            fi
        fi
    fi
fi

# ---------- Done ----------
echo
ok "Setup complete."
echo
echo "Dashboard URL: $KIOSK_URL"
echo "Config file:   $CONFIG_FILE"
echo
echo "Next steps:"
echo "  1. Run the agent setup on your Windows machine (agent/setup.ps1)"
echo "  2. Use the same shared secret on both sides"
echo "  3. Reboot the Pi to launch the kiosk: sudo reboot"
echo
echo "Useful commands:"
echo "  sudo systemctl restart $SERVICE_NAME"
echo "  sudo journalctl -u $SERVICE_NAME -f"
echo "  ./setup.sh --uninstall"
