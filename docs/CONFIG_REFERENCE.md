# Configuration Reference

Every field in `pi/config.json` and `agent/config.json` documented.

## pi/config.json

### Top level

| Field | Type | Default | Description |
|---|---|---|---|
| `port` | number | `3000` | TCP port the Pi server listens on |
| `title` | string | `"Command Deck"` | Brand text shown in the top-left header |
| `agentUrl` | string | *(required)* | Full URL to the Windows agent, e.g. `"http://192.168.0.42:5000"` |
| `sharedSecret` | string | *(required)* | Auth token sent to the agent. Must match `agent/config.json`. Min 16 chars |
| `polling` | object | see below | Polling and cache intervals |
| `ui` | object | see below | UI thresholds and theme |
| `weather` | object \| null | see below | Weather pill settings |
| `instances` | array | `[]` | List of switchable contexts (see Instances) |
| `tiles` | array | *(required)* | Tile definitions (see Tiles) |

### `polling`

| Field | Type | Default | Description |
|---|---|---|---|
| `statusIntervalMs` | number | `30000` | How often the dashboard polls the agent for status |
| `statusCacheMs` | number | `15000` | How long the Pi caches the last status response |
| `weatherIntervalMs` | number | `600000` | How often the dashboard polls weather (10 min default) |
| `weatherCacheMs` | number | `600000` | How long the Pi caches weather data |

### `ui`

| Field | Type | Default | Description |
|---|---|---|---|
| `meetingAlertThresholdMin` | number | `3` | Minutes before a meeting starts that the full-screen alert appears |
| `offlineFailureThreshold` | number | `2` | Consecutive failed polls before showing the offline overlay |
| `offlineDismissResetMs` | number | `300000` | After tapping to dismiss the offline overlay, how long before it can re-appear |
| `theme` | object | see below | Color overrides |

### `ui.theme`

All optional. Each value is a CSS color string. Defaults shown below — these are the colors of the default dark theme.

| Field | Default | Used for |
|---|---|---|
| `accent` | `"#58e1c4"` | Brand mark, instance picker value, default tile color |
| `warn` | `"#f0883e"` | "Cached" connection status |
| `bad` | `"#f85149"` | "Not connected" status, meeting-now glow, offline overlay icon |
| `good` | `"#3fb950"` | "Live" connection status |

### `weather`

Set the whole object to `null` (or `enabled: false`) to disable the weather pill.

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | If false, weather pill hides and `/api/weather` returns 400 |
| `latitude` | number | *(required when enabled)* | Decimal degrees |
| `longitude` | number | *(required when enabled)* | Decimal degrees (negative for W) |
| `unit` | string | `"fahrenheit"` | `"fahrenheit"` or `"celsius"` |

Weather data comes from [Open-Meteo](https://open-meteo.com/) — free, no API key required.

### `instances`

If empty, the instance picker hides entirely and `instancePath` tiles will fail. If you don't have multiple environments to switch between, leave this as `[]` and don't use `instancePath` tiles.

Array of objects, each with:

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique identifier. Used in `state.json` to remember the active instance |
| `label` | string | yes | Short display name shown in the picker pill |
| `client` | string | yes | Group label — instances with the same `client` cluster together in the picker |
| `env` | string | no | Environment tag (`"Dev"`, `"Test"`, `"Prod"`) — colors the env pill in the picker |
| `baseUrl` | string | yes | Origin (no trailing path), e.g. `"https://example-dev.example.com"` |

### `tiles`

Array of tile objects. Each tile has either `command` (action) or `instancePath` (instance-aware), or `type: "group"` (modal).

#### Common fields

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | yes | Unique. Used by `/api/command/:id` |
| `label` | string | yes | Big text on the tile |
| `sublabel` | string | no | Small uppercase text below the label. Supports `{instance}` placeholder |
| `color` | string | no | CSS color used for accent stripe and value glow |
| `statusKey` | string | no | Field name in `/status` response to show as the tile's badge number |

#### Action tile (most common)

```json
{
    "id": "outlook",
    "label": "Outlook",
    "color": "#0078D4",
    "command": "launch_outlook",
    "statusKey": "outlookUnread"
}
```

| Field | Type | Description |
|---|---|---|
| `command` | string | Whitelisted handler name in the agent |
| `args` | array | Positional args passed to the handler. E.g. `["https://example.com"]` for `open_url` |

#### Instance-aware tile

```json
{
    "id": "background-scripts",
    "label": "Background Scripts",
    "instancePath": "/sys.scripts.do"
}
```

| Field | Type | Description |
|---|---|---|
| `instancePath` | string | Path appended to the active instance's `baseUrl`. Resolved at click time |

#### Group tile

```json
{
    "id": "acme",
    "label": "Acme Corp",
    "type": "group",
    "children": [
        { "id": "acme-dev",  "label": "Dev",  "command": "open_url", "args": ["https://acme-dev.example.com"] },
        { "id": "acme-prod", "label": "Prod", "command": "open_url", "args": ["https://acme.example.com"] }
    ]
}
```

| Field | Type | Description |
|---|---|---|
| `type` | string | Must be `"group"` |
| `children` | array | Child tiles shown in the modal. Each child can be any tile type, including another group |

---

## agent/config.json

### Top level

| Field | Type | Default | Description |
|---|---|---|---|
| `port` | number | `5000` | TCP port the agent listens on |
| `sharedSecret` | string | *(required)* | Must match `pi/config.json`. Min 16 chars |
| `outlook` | object | see below | Outlook integration settings |
| `cache` | object | see below | Cache settings |

### `outlook`

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `false` | If false, `outlookUnread` and `nextMeeting` always return null |
| `exePath` | string | `"C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE"` | Path to **classic** Outlook (not "new Outlook"). Used by the `launch_outlook` command |
| `calendarLookaheadHours` | number | `24` | How far ahead to look for the next meeting |

### `cache`

| Field | Type | Default | Description |
|---|---|---|---|
| `statusMs` | number | `20000` | How long the agent caches the result of `buildStatus()` before re-running PowerShell |

---

## What's hardcoded (and isn't configurable)

By design, to keep the config from sprawling:

- Tile grid is 4×3 (12 slots). Modify `style.css` if you want a different layout
- Polling interval minimum is 1 second (the cache TTL, not the polling interval, is the actual constraint)
- Agent timeout per request is 5 seconds (Pi → agent), 8 seconds (agent → PowerShell), 12 seconds (calendar specifically)
- The kiosk autostart command in setup.sh
- Font family (Space Grotesk + JetBrains Mono via Google Fonts)

If you need any of these tunable, fork or PR.
