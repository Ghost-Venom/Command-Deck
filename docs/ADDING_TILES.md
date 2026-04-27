# Adding Tiles, Instances, and Custom Commands

Recipes for extending Command Deck. All Pi-side changes happen in `pi/config.json`. All agent-side changes happen in `agent/agent.js`.

After editing `pi/config.json`:

```bash
sudo systemctl restart command-deck
```

After editing `agent/agent.js`:

```powershell
pm2 restart command-deck-agent
```

---

## Add a simple URL tile

Just opens a webpage in your default browser.

```json
{
    "id": "github",
    "label": "GitHub",
    "sublabel": "personal",
    "color": "#22C55E",
    "command": "open_url",
    "args": ["https://github.com"]
}
```

Works for any `https://` URL. Will not work for `file://`, `chrome://`, etc.

---

## Add a tile that runs a custom command

Two steps. First, define the handler on the agent (`agent/agent.js`, `commands` object):

```javascript
const commands = {
    // ...existing handlers...

    open_calculator: () => runShell('start calc'),
    flush_dns: () => runShell('ipconfig /flushdns'),
    restart_outlook: () => runShell('taskkill /F /IM outlook.exe && start outlook')
};
```

Then add the tile in `pi/config.json`:

```json
{
    "id": "flush-dns",
    "label": "Flush DNS",
    "sublabel": "fix dns issues",
    "color": "#F59E0B",
    "command": "flush_dns"
}
```

Restart both sides.

---

## Add a status badge tile (live data)

Two-step pattern again. Read the data on the agent, display it on a tile.

In `agent/agent.js`, add a getter and wire into `buildStatus`:

```javascript
async function getDiskFreeGb() {
    const out = await runPS('[math]::Round((Get-PSDrive C).Free / 1GB)');
    return parseInt(out, 10);
}

async function buildStatus() {
    // ...existing code...

    try { status.diskFreeGb = await getDiskFreeGb(); }
    catch (err) { status.diskFreeGb = null; }

    // ...
}
```

In `pi/config.json`:

```json
{
    "id": "disk",
    "label": "Disk",
    "sublabel": "free GB",
    "color": "#0EA5E9",
    "statusKey": "diskFreeGb"
}
```

The tile will show the number from `status.diskFreeGb`. If the value is `null`, it shows `—`. If `0`, it shows a dim "0".

You can also combine `statusKey` with a `command` so the tile is both a count display *and* tappable.

---

## Add an instance-aware tile

Tiles whose URL changes based on the active instance picker.

```json
{
    "id": "rest-explorer",
    "label": "REST Explorer",
    "sublabel": "API testing",
    "color": "#0EA5E9",
    "instancePath": "/$restapi.do"
}
```

When tapped, the Pi composes:
```
<active instance baseUrl> + <instancePath>
```

So if the active instance is `{ baseUrl: "https://example-dev.example.com" }`, this tile opens `https://example-dev.example.com/$restapi.do`.

The tile shows a small badge with the active instance label so you always know what you're targeting.

---

## Add a new instance

Add to the `instances` array in `pi/config.json`:

```json
{
    "id": "newco-dev",
    "label": "NewCo Dev",
    "client": "NewCo",
    "env": "Dev",
    "baseUrl": "https://newco-dev.example.com"
}
```

The instance picker will show it grouped under "NewCo." Restart the Pi server to pick it up.

If you want the Pi to default to this instance, edit `pi/state.json` (or just select it in the picker once — it persists).

---

## Add a group tile

Group tiles open a modal of sub-tiles when tapped. Useful for grouping related actions without eating top-level grid slots.

```json
{
    "id": "newco",
    "label": "NewCo",
    "sublabel": "all environments",
    "color": "#0F4C81",
    "type": "group",
    "children": [
        { "id": "newco-dev",  "label": "Dev",  "color": "#22C55E", "command": "open_url", "args": ["https://newco-dev.example.com/login"] },
        { "id": "newco-test", "label": "Test", "color": "#F59E0B", "command": "open_url", "args": ["https://newco-test.example.com/login"] },
        { "id": "newco-prod", "label": "Prod", "color": "#DC2626", "command": "open_url", "args": ["https://newco.example.com/login"] }
    ]
}
```

Children can be any tile type — even other groups (the modal nests).

---

## Use the `{instance}` placeholder in sublabels

In any tile sublabel, `{instance}` is replaced with the active instance's `label`:

```json
{
    "id": "my-tasks",
    "label": "My Tasks",
    "sublabel": "in {instance}",
    "instancePath": "/now/nav/list/sn_my_tasks.do"
}
```

If active instance is "NewCo Dev", the tile shows "in NewCo Dev" as its sublabel.

---

## Common useful command patterns

### Open a file or folder

```javascript
open_downloads: () => runShell('start "" "C:\\Users\\Steven\\Downloads"'),
open_notes: () => runShell('start "" "C:\\Users\\Steven\\notes.md"')
```

### Run a PowerShell script

```javascript
my_script: () => runPS('& "C:\\scripts\\my-script.ps1"', 30000)
```

The second arg is timeout in ms. Default is 8 seconds.

### Restart a service

```javascript
restart_iis: () => runPS('Restart-Service -Name "W3SVC"')
```

(May need elevation; see notes.)

### Send a Teams deep link

```javascript
dm_manager: () => runShell('start "" "msteams:/l/chat/0/0?users=manager@example.com"')
```

### Take a screenshot

```javascript
screenshot: () => runShell('start ms-screenclip:')
```

### Set Focus Assist

```javascript
focus_on: () => runPS('(New-Object -ComObject WScript.Shell).SendKeys("^+f")')
```

(Probably more reliable to use `Add-Type` and call user32 directly, but for simple cases SendKeys works.)

---

## Notes on elevation

- The agent runs **non-elevated** (so it can talk to Outlook COM)
- Commands inherit the agent's privilege level
- Anything requiring Admin (modifying services, system settings, etc.) won't work directly
- Workaround: pre-create a scheduled task that *is* elevated, and have the tile trigger it via `schtasks /run /tn "MyTask"`

---

## Common pitfalls

- **JSON requires double quotes everywhere.** No trailing commas. Validate with `node -e "JSON.parse(require('fs').readFileSync('config.json'))"` before restarting.
- **Backslashes in JSON strings must be doubled.** `"C:\\Users\\Steven"` not `"C:\Users\Steven"`.
- **Restart the right service.** Pi changes → `sudo systemctl restart command-deck`. Agent changes → `pm2 restart command-deck-agent`.
- **Tile count limit.** The grid is 4×3 (12 tiles) by default. Tiles beyond that won't appear visually until you adjust the CSS.
