/*
 * Command Deck — Windows Agent
 *
 * Runs on the work machine. Exposes /status (read-only) and /command (whitelisted ops).
 * Authentication: shared secret via X-Auth-Token header.
 *
 * Outlook integration is optional and configurable; see config.json.
 */

const express = require('express');
const { exec, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

// ---------- Config loading ----------

let config;
try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
    console.error(`FATAL: failed to load ${CONFIG_PATH}: ${err.message}`);
    console.error('Did you copy config.example.json to config.json and edit it?');
    process.exit(1);
}

const PORT = config.port || 5000;
const SECRET = config.sharedSecret;

if (!SECRET || SECRET === 'CHANGE_ME' || SECRET.length < 16) {
    console.error('FATAL: config.json sharedSecret must be set and at least 16 characters');
    process.exit(1);
}

const OUTLOOK = {
    enabled: config.outlook?.enabled ?? false,
    exePath: config.outlook?.exePath || 'C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE',
    calendarLookaheadHours: config.outlook?.calendarLookaheadHours ?? 24
};

const STATUS_CACHE_MS = config.cache?.statusMs ?? 20000;

// ---------- Auth middleware ----------
const app = express();
app.use(express.json());
app.use((req, res, next) => {
    if (req.headers['x-auth-token'] !== SECRET) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
});

// ---------- Helpers ----------

function runPS(script, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { timeout: timeoutMs, windowsHide: true },
            (err, stdout, stderr) => {
                if (err) return reject(new Error(stderr?.trim() || err.message));
                resolve(stdout.trim());
            }
        );
    });
}

function runShell(cmd) {
    return new Promise((resolve, reject) => {
        exec(cmd, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error(stderr?.trim() || err.message));
            resolve(stdout.trim());
        });
    });
}

// ---------- Status providers ----------

async function getOutlookUnread() {
    const script = [
        'try {',
        '  $ol = New-Object -ComObject Outlook.Application;',
        '  $inbox = $ol.GetNamespace("MAPI").GetDefaultFolder(6);',
        '  Write-Output $inbox.UnReadItemCount',
        '} catch {',
        '  Write-Output ("ERROR: " + $_.Exception.Message)',
        '}'
    ].join(' ');
    const out = await runPS(script);
    if (out.startsWith('ERROR')) {
        console.error('[outlook]', out);
        return null;
    }
    if (out === '') return null;
    const n = parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
}

async function getNextMeeting() {
    // Output: ISO start | subject | isNow flag, separated by pipe.
    const script = [
        'try {',
        '  $ol = New-Object -ComObject Outlook.Application;',
        '  $cal = $ol.GetNamespace("MAPI").GetDefaultFolder(9);',
        '  $now = Get-Date;',
        `  $endOfDay = (Get-Date).AddHours(${OUTLOOK.calendarLookaheadHours});`,
        '  $items = $cal.Items;',
        '  $items.IncludeRecurrences = $true;',
        '  $items.Sort("[Start]");',
        '  $fmt = "g";',
        '  $filter = "[End] >= " + [char]39 + $now.ToString($fmt) + [char]39 + " AND [Start] <= " + [char]39 + $endOfDay.ToString($fmt) + [char]39;',
        '  $matches = $items.Restrict($filter);',
        '  $next = $null;',
        '  foreach ($m in $matches) { if ($null -eq $next) { $next = $m; break } };',
        '  if ($null -eq $next) { Write-Output "NONE"; return };',
        '  $isNow = if ($next.Start -le $now -and $next.End -gt $now) { 1 } else { 0 };',
        '  $startIso = $next.Start.ToString("yyyy-MM-ddTHH:mm:ss");',
        '  $subject = $next.Subject -replace "\\|", "/";',
        '  Write-Output ($startIso + "|" + $subject + "|" + $isNow)',
        '} catch {',
        '  Write-Output ("ERROR: " + $_.Exception.Message)',
        '}'
    ].join(' ');
    const out = await runPS(script, 12000);
    if (out.startsWith('ERROR')) { console.error('[meeting]', out); return null; }
    if (out === 'NONE' || out === '') return null;
    const parts = out.split('|');
    if (parts.length < 3) return null;
    return { startIso: parts[0], subject: parts[1], isNow: parts[2] === '1' };
}

const statusCache = { data: null, fetchedAt: 0 };

async function buildStatus() {
    const now = Date.now();
    if (statusCache.data && (now - statusCache.fetchedAt) < STATUS_CACHE_MS) {
        return statusCache.data;
    }
    const status = { timestamp: new Date().toISOString() };

    if (OUTLOOK.enabled) {
        try { status.outlookUnread = await getOutlookUnread(); }
        catch (err) { console.error('[outlook]', err.message); status.outlookUnread = null; }
        try { status.nextMeeting = await getNextMeeting(); }
        catch (err) { console.error('[meeting]', err.message); status.nextMeeting = null; }
    } else {
        status.outlookUnread = null;
        status.nextMeeting = null;
    }

    statusCache.data = status;
    statusCache.fetchedAt = now;
    return status;
}

// ---------- Command whitelist ----------

const commands = {
    launch_outlook: () => {
        if (OUTLOOK.enabled && OUTLOOK.exePath) {
            return runShell(`start "" "${OUTLOOK.exePath}"`);
        }
        return runShell('start outlook:');
    },

    launch_teams: () => runShell('start msteams:'),

    open_url: (args) => {
        const url = args?.[0];
        if (!url || typeof url !== 'string') throw new Error('open_url requires a url arg');
        if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http(s)://');
        return runShell(`start "" "${url.replace(/"/g, '')}"`);
    },

    lock_workstation: () => runShell('rundll32.exe user32.dll,LockWorkStation'),

    // Placeholder for tiles slated for future features (Teams DND via Graph, etc)
    noop_v2: () => Promise.resolve('placeholder')
};

// ---------- Routes ----------

app.get('/health', (req, res) => res.json({ ok: true }));

app.get('/status', async (req, res) => {
    try { res.json(await buildStatus()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/command', async (req, res) => {
    const { command, args } = req.body || {};
    const handler = commands[command];
    if (!handler) {
        return res.status(400).json({ error: 'unknown_command', command });
    }
    try {
        await handler(args);
        statusCache.fetchedAt = 0;
        res.json({ ok: true, command });
    } catch (err) {
        console.error(`[command:${command}]`, err.message);
        res.status(500).json({ error: 'command_failed', command, message: err.message });
    }
});

// ---------- Boot ----------

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Command Deck agent listening on http://0.0.0.0:${PORT}`);
    console.log(`Outlook integration: ${OUTLOOK.enabled ? 'enabled' : 'disabled'}`);
    if (OUTLOOK.enabled) console.log(`Outlook exe: ${OUTLOOK.exePath}`);
    console.log(`Available commands: ${Object.keys(commands).join(', ')}`);
});
