/*
 * Command Deck — Pi Dashboard Server
 *
 * Serves the touchscreen dashboard, proxies status/commands to the Windows agent,
 * proxies weather to Open-Meteo, and manages active-instance state.
 *
 * All tunables live in config.json. See docs/CONFIG_REFERENCE.md.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const STATE_PATH = path.join(__dirname, 'state.json');

// ---------- Config loading ----------

let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
    console.error(`FATAL: failed to load ${CONFIG_PATH}: ${err.message}`);
    console.error('Did you copy config.example.json to config.json and edit it?');
    process.exit(1);
}

// Validate required fields and surface friendly errors
const REQUIRED_FIELDS = ['agentUrl', 'sharedSecret', 'instances', 'tiles'];
for (const f of REQUIRED_FIELDS) {
    if (config[f] === undefined) {
        console.error(`FATAL: config.json missing required field "${f}"`);
        process.exit(1);
    }
}
if (config.sharedSecret === 'CHANGE_ME' || config.sharedSecret.length < 16) {
    console.error('FATAL: config.json sharedSecret must be set and at least 16 characters');
    process.exit(1);
}

// ---------- Defaults (anything not in config falls back here) ----------
const PORT = config.port || 3000;
const POLLING = {
    statusIntervalMs: config.polling?.statusIntervalMs ?? 30000,
    statusCacheMs: config.polling?.statusCacheMs ?? 15000,
    weatherIntervalMs: config.polling?.weatherIntervalMs ?? 600000,
    weatherCacheMs: config.polling?.weatherCacheMs ?? 600000
};
const UI = {
    meetingAlertThresholdMin: config.ui?.meetingAlertThresholdMin ?? 3,
    offlineFailureThreshold: config.ui?.offlineFailureThreshold ?? 2,
    offlineDismissResetMs: config.ui?.offlineDismissResetMs ?? 300000,
    theme: config.ui?.theme || {}
};

// ---------- State (active instance, persisted) ----------

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        return { activeInstanceId: config.instances?.[0]?.id || null };
    }
}

function saveState(state) {
    const tmp = STATE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_PATH);
}

let state = loadState();

function getActiveInstance() {
    if (!config.instances?.length) return null;
    return config.instances.find(i => i.id === state.activeInstanceId) || config.instances[0];
}

// ---------- Tile resolution ----------

function findTile(tileId) {
    for (const tile of config.tiles) {
        if (tile.id === tileId) return { tile, parent: null };
        if (tile.children) {
            const child = tile.children.find(c => c.id === tileId);
            if (child) return { tile: child, parent: tile };
        }
    }
    return null;
}

function resolveCommand(tile) {
    if (tile.command) {
        return { command: tile.command, args: tile.args || [] };
    }
    if (tile.instancePath) {
        const inst = getActiveInstance();
        if (!inst) throw new Error('no active instance set');
        const url = inst.baseUrl.replace(/\/$/, '') + tile.instancePath;
        return { command: 'open_url', args: [url] };
    }
    throw new Error(`tile ${tile.id} has no command or instancePath`);
}

// ---------- Caches ----------

let statusCache = { data: null, fetchedAt: 0 };
let weatherCache = { data: null, fetchedAt: 0 };

// ---------- App ----------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
    res.json({
        tiles: config.tiles,
        instances: config.instances || [],
        weather: config.weather?.enabled === false ? null : (config.weather || null),
        polling: POLLING,
        ui: UI,
        title: config.title || 'Command Deck'
    });
});

app.get('/api/state', (req, res) => {
    res.json({
        activeInstanceId: state.activeInstanceId,
        activeInstance: getActiveInstance() || null
    });
});

app.put('/api/state', (req, res) => {
    const { activeInstanceId } = req.body || {};
    const inst = config.instances?.find(i => i.id === activeInstanceId);
    if (!inst) return res.status(400).json({ error: 'unknown_instance' });
    state.activeInstanceId = activeInstanceId;
    saveState(state);
    res.json({ activeInstanceId, activeInstance: inst });
});

app.get('/api/status', async (req, res) => {
    const now = Date.now();
    if (statusCache.data && (now - statusCache.fetchedAt) < POLLING.statusCacheMs) {
        return res.json({ ...statusCache.data, cached: true });
    }
    try {
        const response = await fetch(`${config.agentUrl}/status`, {
            headers: { 'X-Auth-Token': config.sharedSecret },
            signal: AbortSignal.timeout(5000)
        });
        if (!response.ok) throw new Error(`Agent returned ${response.status}`);
        const data = await response.json();
        statusCache = { data, fetchedAt: now };
        res.json({ ...data, cached: false });
    } catch (err) {
        console.error('[status] agent fetch failed:', err.message);
        res.status(503).json({
            error: 'agent_unreachable',
            message: err.message,
            stale: statusCache.data
        });
    }
});

app.get('/api/weather', async (req, res) => {
    if (config.weather?.enabled === false || !config.weather?.latitude) {
        return res.status(400).json({ error: 'weather_not_configured' });
    }
    const now = Date.now();
    if (weatherCache.data && (now - weatherCache.fetchedAt) < POLLING.weatherCacheMs) {
        return res.json({ ...weatherCache.data, cached: true });
    }
    const w = config.weather;
    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${w.latitude}&longitude=${w.longitude}&current=temperature_2m,weather_code&temperature_unit=${w.unit || 'fahrenheit'}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);
        const data = await response.json();
        const out = {
            temp: Math.round(data.current.temperature_2m),
            unit: w.unit === 'celsius' ? 'C' : 'F',
            code: data.current.weather_code,
            time: data.current.time
        };
        weatherCache = { data: out, fetchedAt: now };
        res.json(out);
    } catch (err) {
        console.error('[weather] fetch failed:', err.message);
        res.status(503).json({ error: 'weather_unreachable', message: err.message });
    }
});

app.post('/api/command/:tileId', async (req, res) => {
    const found = findTile(req.params.tileId);
    if (!found) return res.status(404).json({ error: 'tile_not_found' });
    const { tile } = found;

    let resolved;
    try {
        resolved = resolveCommand(tile);
    } catch (err) {
        return res.status(400).json({ error: 'unresolvable', message: err.message });
    }

    try {
        const response = await fetch(`${config.agentUrl}/command`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Auth-Token': config.sharedSecret
            },
            body: JSON.stringify(resolved),
            signal: AbortSignal.timeout(5000)
        });
        const data = await response.json();
        statusCache.fetchedAt = 0;
        res.status(response.status).json({ ...data, resolved });
    } catch (err) {
        console.error('[command] agent send failed:', err.message);
        res.status(503).json({ error: 'agent_unreachable', message: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Command Deck server listening on http://0.0.0.0:${PORT}`);
    console.log(`Agent target: ${config.agentUrl}`);
    console.log(`Active instance: ${state.activeInstanceId || '(none)'}`);
});
