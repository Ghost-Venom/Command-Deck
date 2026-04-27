/* Command Deck — frontend logic */

const grid = document.getElementById('grid');
const connDot = document.getElementById('conn-dot');
const connText = document.getElementById('conn-text');
const clockEl = document.getElementById('clock');
const lastUpdateEl = document.getElementById('last-update');
const tileCountEl = document.getElementById('tile-count');
const brandTitleEl = document.getElementById('brand-title');
const weatherEl = document.getElementById('weather');
const weatherIconEl = document.getElementById('weather-icon');
const weatherTextEl = document.getElementById('weather-text');
const meetingEl = document.getElementById('meeting');
const meetingTextEl = meetingEl?.querySelector('.hero-text');
const meetingIconEl = meetingEl?.querySelector('.hero-icon');
const instancePickerEl = document.getElementById('instance-picker');
const activeInstanceLabelEl = document.getElementById('active-instance-label');

const modalBackdrop = document.getElementById('modal-backdrop');
const modalTitle = document.getElementById('modal-title');
const modalBody = document.getElementById('modal-body');
const modalCloseBtn = document.getElementById('modal-close');

const offlineOverlay = document.getElementById('offline-overlay');
const offlineDetail = document.getElementById('offline-detail');

const meetingAlert = document.getElementById('meeting-alert');
const meetingCountdownEl = document.getElementById('meeting-countdown');
const meetingSubjectEl = document.getElementById('meeting-subject');
const meetingTimeEl = document.getElementById('meeting-time');

let appConfig = null;
let activeInstance = null;
let pollTimer = null;
let weatherTimer = null;
let meetingTickTimer = null;
let lastStatus = null;

// Configurable, but with sane fallbacks until config loads
let CFG = {
    statusIntervalMs: 30000,
    weatherIntervalMs: 600000,
    meetingAlertThresholdMin: 3,
    offlineFailureThreshold: 2,
    offlineDismissResetMs: 300000
};

let consecutiveFailures = 0;
let overlayManuallyDismissed = false;
let dismissedMeetingKey = null;

/* ---------- Theme ---------- */

function applyTheme(theme) {
    if (!theme) return;
    const root = document.documentElement;
    if (theme.accent) root.style.setProperty('--accent', theme.accent);
    if (theme.warn)   root.style.setProperty('--warn', theme.warn);
    if (theme.bad)    root.style.setProperty('--bad', theme.bad);
    if (theme.good)   root.style.setProperty('--good', theme.good);
}

/* ---------- Tile rendering ---------- */

function buildTile(tile) {
    const el = document.createElement('div');
    el.className = 'tile';
    el.dataset.tileId = tile.id;
    el.dataset.statusKey = tile.statusKey || '';
    el.style.setProperty('--tile-color', tile.color || 'var(--accent)');

    const isGroup = tile.type === 'group';
    const isInstanceAware = !!tile.instancePath;
    const sublabel = resolveSublabel(tile);

    let badge = '';
    if (isGroup) badge = '<div class="tile-badge">group</div>';
    else if (isInstanceAware) badge = `<div class="tile-badge">${escapeHtml(activeInstance?.label || '—')}</div>`;

    el.innerHTML = `
        <div class="tile-head">
            <div>
                <div class="tile-label">${escapeHtml(tile.label)}</div>
                <div class="tile-sublabel">${escapeHtml(sublabel)}</div>
            </div>
            ${badge}
        </div>
        <div class="tile-value"></div>
    `;

    const valueEl = el.querySelector('.tile-value');
    if (tile.statusKey) {
        el.classList.add('loading');
    } else if (isGroup) {
        valueEl.classList.add('arrow'); valueEl.textContent = '⊞';
    } else {
        valueEl.classList.add('arrow'); valueEl.textContent = '↗';
    }

    el.addEventListener('click', () => handleTileTap(tile, el));
    return el;
}

function resolveSublabel(tile) {
    if (!tile.sublabel) return '';
    return tile.sublabel.replace('{instance}', activeInstance?.label || '');
}

function renderTiles() {
    grid.innerHTML = '';
    appConfig.tiles.forEach(t => grid.appendChild(buildTile(t)));
    tileCountEl.textContent = `${appConfig.tiles.length} tiles`;
}

function refreshInstanceAwareTiles() {
    renderTiles();
    if (lastStatus) updateTileValues(lastStatus);
}

function updateTileValues(status) {
    lastStatus = status;
    document.querySelectorAll('.tile').forEach(el => {
        const key = el.dataset.statusKey;
        if (!key) return;
        const valEl = el.querySelector('.tile-value');
        const v = status?.[key];
        el.classList.remove('loading');
        valEl.className = 'tile-value';
        if (v === undefined || v === null) {
            valEl.textContent = '—';
            valEl.classList.add('zero');
        } else {
            valEl.textContent = v;
            if (v === 0) valEl.classList.add('zero');
        }
    });
    updateMeetingPill(status?.nextMeeting);
}

function markTilesDisconnected() {
    document.querySelectorAll('.tile').forEach(el => {
        if (!el.dataset.statusKey) return;
        el.classList.remove('loading');
        el.classList.add('disconnected');
        const valEl = el.querySelector('.tile-value');
        valEl.textContent = '?';
        valEl.className = 'tile-value zero';
    });
}

/* ---------- Tile actions ---------- */

function handleTileTap(tile, el) {
    if (tile.type === 'group') return openGroupModal(tile);
    fireTile(tile, el);
}

async function fireTile(tile, el) {
    if (el) {
        el.classList.add('firing');
        setTimeout(() => el.classList.remove('firing'), 220);
    }
    try {
        const res = await fetch(`/api/command/${encodeURIComponent(tile.id)}`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            console.error('Command failed:', err);
            flashConnection('bad', `cmd failed: ${err.error || res.status}`);
        } else {
            setTimeout(pollStatus, 800);
        }
    } catch (err) {
        console.error(err);
        flashConnection('bad', 'cmd offline');
    }
}

/* ---------- Modals ---------- */

function openModal(title, contentNode) {
    modalTitle.innerHTML = title;
    modalBody.innerHTML = '';
    modalBody.appendChild(contentNode);
    modalBackdrop.hidden = false;
}
function closeModal() { modalBackdrop.hidden = true; }

modalCloseBtn.addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) closeModal(); });

function openGroupModal(tile) {
    const titleHtml = `${escapeHtml(tile.label)} <small>${escapeHtml(tile.sublabel || '')}</small>`;
    const body = document.createElement('div');

    if (!tile.children || tile.children.length === 0) {
        body.className = 'modal-empty';
        body.textContent = 'No items configured yet';
    } else {
        body.className = 'modal-grid';
        tile.children.forEach(child => {
            const subEl = buildTile(child);
            const clone = subEl.cloneNode(true);
            clone.addEventListener('click', () => {
                if (child.type === 'group') {
                    openGroupModal(child);
                } else {
                    fireTile(child, clone);
                    setTimeout(closeModal, 300);
                }
            });
            body.appendChild(clone);
        });
    }
    openModal(titleHtml, body);
}

function openInstancePicker() {
    const titleHtml = 'Active Instance <small>tap to switch</small>';
    const body = document.createElement('div');
    body.className = 'instance-list';

    const groups = {};
    for (const inst of appConfig.instances) {
        (groups[inst.client] = groups[inst.client] || []).push(inst);
    }

    for (const client of Object.keys(groups)) {
        const groupEl = document.createElement('div');
        groupEl.className = 'instance-group';
        groupEl.innerHTML = `<div class="instance-group-title">${escapeHtml(client)}</div>`;

        for (const inst of groups[client]) {
            const row = document.createElement('div');
            row.className = 'instance-row';
            if (inst.id === activeInstance?.id) row.classList.add('active');

            const envClass = (inst.env || '').toLowerCase();
            row.innerHTML = `
                <div class="row-main">
                    <div class="row-label">${escapeHtml(inst.label)}</div>
                    <div class="row-sub">${escapeHtml(inst.baseUrl.replace(/^https?:\/\//, ''))}</div>
                </div>
                <div class="row-env ${envClass}">${escapeHtml(inst.env || '')}</div>
            `;
            row.addEventListener('click', () => selectInstance(inst.id));
            groupEl.appendChild(row);
        }
        body.appendChild(groupEl);
    }
    openModal(titleHtml, body);
}

async function selectInstance(instanceId) {
    try {
        const res = await fetch('/api/state', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ activeInstanceId: instanceId })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        activeInstance = data.activeInstance;
        updateActiveInstanceLabel();
        refreshInstanceAwareTiles();
        closeModal();
    } catch (err) {
        console.error('Failed to set instance:', err);
    }
}

instancePickerEl.addEventListener('click', openInstancePicker);

function updateActiveInstanceLabel() {
    activeInstanceLabelEl.textContent = activeInstance?.label || '—';
}

/* ---------- Status polling ---------- */

async function pollStatus() {
    try {
        const res = await fetch('/api/status');
        if (res.status === 503) {
            const data = await res.json();
            handleAgentFailure(data?.message || 'agent unreachable');
            if (data.stale) updateTileValues(data.stale);
            else markTilesDisconnected();
            return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        handleAgentSuccess(data.cached);
        updateTileValues(data);
        document.querySelectorAll('.tile').forEach(el => el.classList.remove('disconnected'));
        lastUpdateEl.textContent = `last sync ${formatTime(new Date())}`;
    } catch (err) {
        console.error('poll failed:', err);
        handleAgentFailure(err.message || 'pi error');
    }
}

function handleAgentSuccess(isCached) {
    consecutiveFailures = 0;
    setConnection(isCached ? 'warn' : 'ok', isCached ? 'cached' : 'live');
    hideOfflineOverlay();
}

function handleAgentFailure(detail) {
    consecutiveFailures++;
    setConnection('bad', 'not connected');
    if (consecutiveFailures >= CFG.offlineFailureThreshold && !overlayManuallyDismissed) {
        showOfflineOverlay(detail);
    }
}

function showOfflineOverlay(detail) {
    if (offlineDetail && detail) offlineDetail.textContent = detail.length > 60 ? 'waiting for agent…' : detail;
    offlineOverlay.classList.add('visible');
}

function hideOfflineOverlay() {
    offlineOverlay.classList.remove('visible');
    overlayManuallyDismissed = false;
}

offlineOverlay.addEventListener('click', () => {
    offlineOverlay.classList.remove('visible');
    overlayManuallyDismissed = true;
    setTimeout(() => { overlayManuallyDismissed = false; }, CFG.offlineDismissResetMs);
});

function startPolling(intervalMs) {
    if (pollTimer) clearInterval(pollTimer);
    pollStatus();
    pollTimer = setInterval(pollStatus, intervalMs);
}

/* ---------- Weather ---------- */

const WEATHER_ICONS = {
    0: '☀',  1: '☀',  2: '⛅', 3: '☁',
    45: '🌫', 48: '🌫',
    51: '🌦', 53: '🌦', 55: '🌧',
    56: '🌧', 57: '🌧',
    61: '🌧', 63: '🌧', 65: '🌧',
    66: '🌧', 67: '🌧',
    71: '🌨', 73: '🌨', 75: '🌨',
    77: '🌨',
    80: '🌦', 81: '🌧', 82: '⛈',
    85: '🌨', 86: '🌨',
    95: '⛈',  96: '⛈',  99: '⛈'
};

async function pollWeather() {
    try {
        const res = await fetch('/api/weather');
        if (res.status === 400) { weatherEl.hidden = true; return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const icon = WEATHER_ICONS[data.code] || '·';
        weatherEl.hidden = false;
        weatherIconEl.textContent = icon;
        weatherTextEl.textContent = `${data.temp}°${data.unit || ''}`;
    } catch (err) {
        console.warn('weather fetch failed:', err.message);
        if (weatherTextEl) weatherTextEl.textContent = '--°';
    }
}

function startWeatherPolling(intervalMs) {
    if (weatherTimer) clearInterval(weatherTimer);
    pollWeather();
    weatherTimer = setInterval(pollWeather, intervalMs);
}

/* ---------- Meeting alert ---------- */

function updateMeetingPill(meeting) {
    if (!meetingEl) return;
    if (!meeting) {
        meetingEl.classList.remove('now');
        meetingIconEl.textContent = '▷';
        meetingTextEl.textContent = 'no meetings';
        evaluateMeetingAlert(null);
        return;
    }
    const start = new Date(meeting.startIso);
    if (meeting.isNow) {
        meetingEl.classList.add('now');
        meetingIconEl.textContent = '●';
        meetingTextEl.textContent = `NOW · ${truncate(meeting.subject, 32)}`;
    } else {
        meetingEl.classList.remove('now');
        meetingIconEl.textContent = '▷';
        const mins = Math.round((start - Date.now()) / 60000);
        const when = mins < 60 ? `in ${mins}min` : start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        meetingTextEl.textContent = `${when} · ${truncate(meeting.subject, 28)}`;
    }
    evaluateMeetingAlert(meeting);
}

function meetingKey(m) { return m ? `${m.startIso}|${m.subject}` : null; }

function evaluateMeetingAlert(meeting) {
    if (!meeting) { hideMeetingAlert(); return; }
    const start = new Date(meeting.startIso);
    const minsUntil = (start - Date.now()) / 60000;
    const key = meetingKey(meeting);
    const inAlertWindow = (meeting.isNow || minsUntil <= CFG.meetingAlertThresholdMin);

    if (inAlertWindow && dismissedMeetingKey !== key) {
        showMeetingAlert(meeting);
    } else if (!inAlertWindow) {
        if (dismissedMeetingKey && dismissedMeetingKey !== key) dismissedMeetingKey = null;
        hideMeetingAlert();
    } else {
        hideMeetingAlert();
    }
}

function showMeetingAlert(meeting) {
    const start = new Date(meeting.startIso);
    meetingSubjectEl.textContent = meeting.subject || 'Untitled meeting';
    meetingTimeEl.textContent = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    updateMeetingCountdown(meeting);
    meetingAlert.classList.add('visible');
    if (meeting.isNow) meetingAlert.classList.add('starting-now');
    else meetingAlert.classList.remove('starting-now');

    if (!meetingTickTimer) {
        meetingTickTimer = setInterval(() => {
            if (lastStatus?.nextMeeting) updateMeetingCountdown(lastStatus.nextMeeting);
        }, 1000);
    }
}

function hideMeetingAlert() {
    meetingAlert.classList.remove('visible', 'starting-now');
    if (meetingTickTimer) { clearInterval(meetingTickTimer); meetingTickTimer = null; }
}

function updateMeetingCountdown(meeting) {
    const start = new Date(meeting.startIso);
    const diffSec = Math.round((start - Date.now()) / 1000);
    if (meeting.isNow || diffSec <= 0) {
        meetingCountdownEl.textContent = 'NOW';
        meetingAlert.classList.add('starting-now');
    } else {
        const m = Math.floor(diffSec / 60);
        const s = diffSec % 60;
        meetingCountdownEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }
}

meetingAlert.addEventListener('click', () => {
    if (lastStatus?.nextMeeting) dismissedMeetingKey = meetingKey(lastStatus.nextMeeting);
    hideMeetingAlert();
});

/* ---------- UI helpers ---------- */

function setConnection(state, text) {
    connDot.className = `status-dot ${state}`;
    connText.textContent = text;
}

let flashTimer = null;
function flashConnection(state, text) {
    setConnection(state, text);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => pollStatus(), 1500);
}

function tickClock() { clockEl.textContent = formatTime(new Date()); }

function formatTime(d) {
    const h = d.getHours() % 12 || 12;
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
    return `${h}:${m} ${ampm}`;
}

function truncate(s, n) {
    if (!s) return '';
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/* ---------- Boot ---------- */

(async function init() {
    try {
        const [cfgRes, stateRes] = await Promise.all([
            fetch('/api/config'),
            fetch('/api/state')
        ]);
        appConfig = await cfgRes.json();
        const stateData = await stateRes.json();
        activeInstance = stateData.activeInstance;

        // Apply runtime config
        if (appConfig.title) brandTitleEl.textContent = appConfig.title.toUpperCase();
        applyTheme(appConfig.ui?.theme);
        CFG = {
            statusIntervalMs: appConfig.polling?.statusIntervalMs ?? CFG.statusIntervalMs,
            weatherIntervalMs: appConfig.polling?.weatherIntervalMs ?? CFG.weatherIntervalMs,
            meetingAlertThresholdMin: appConfig.ui?.meetingAlertThresholdMin ?? CFG.meetingAlertThresholdMin,
            offlineFailureThreshold: appConfig.ui?.offlineFailureThreshold ?? CFG.offlineFailureThreshold,
            offlineDismissResetMs: appConfig.ui?.offlineDismissResetMs ?? CFG.offlineDismissResetMs
        };

        // Hide instance picker if no instances configured
        if (!appConfig.instances?.length) {
            instancePickerEl.hidden = true;
        } else {
            instancePickerEl.hidden = false;
            updateActiveInstanceLabel();
        }

        renderTiles();
        startPolling(CFG.statusIntervalMs);
        if (appConfig.weather) startWeatherPolling(CFG.weatherIntervalMs);
    } catch (err) {
        console.error('Failed to initialize:', err);
        setConnection('bad', 'config error');
    }
    tickClock();
    setInterval(tickClock, 30000);
})();

document.addEventListener('gesturestart', e => e.preventDefault());
document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });
