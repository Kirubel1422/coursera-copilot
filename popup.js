// Coursera Autopilot — popup.js  v1.3
const DEFAULTS = {
  enabled: false,
  videoSpeed: 16,
  autoAdvance: true,
  smartSkip: true,
  skipAssignments: true,
  dismissPopups: true,
};

let settings = { ...DEFAULTS };

// ── DOM refs ──────────────────────────────────────────────────
const enabledToggle          = document.getElementById('enabledToggle');
const speedRange             = document.getElementById('speedRange');
const speedDisplay           = document.getElementById('speedDisplay');
const autoAdvanceToggle      = document.getElementById('autoAdvanceToggle');
const smartSkipToggle        = document.getElementById('smartSkipToggle');
const skipAssignmentsToggle  = document.getElementById('skipAssignmentsToggle');
const autoDismissToggle      = document.getElementById('autoDismissToggle');
const statusPill             = document.getElementById('statusPill');
const videoDot               = document.getElementById('videoDot');
const videoInfo              = document.getElementById('videoInfo');
const masterToggle           = document.getElementById('masterToggle');
const controlsBlock          = document.getElementById('controlsBlock');
const footerNote             = document.getElementById('footerNote');
const refreshBtn             = document.getElementById('refreshBtn');
const presets                = document.querySelectorAll('.preset');

// ── Helpers ───────────────────────────────────────────────────
function isCourseraUrl(url) {
  return /^https:\/\/(www\.)?coursera\.org\//.test(url || '');
}

function updateSpeedUI(speed) {
  speedRange.value = speed;
  speedDisplay.innerHTML = `${Number.isInteger(speed) ? speed : speed.toFixed(1)}<span>×</span>`;
  presets.forEach(p => p.classList.toggle('active', parseFloat(p.dataset.speed) === speed));
}

function updateEnabledUI(enabled) {
  statusPill.textContent = enabled ? 'ON' : 'OFF';
  statusPill.className   = 'status-pill ' + (enabled ? 'on' : 'off');
  masterToggle.classList.toggle('active', enabled);
  controlsBlock.classList.toggle('disabled-mask', !enabled);
}

function updateOptionRow(id, checked) {
  const row = document.getElementById('row-' + id);
  if (row) row.classList.toggle('active', checked);
}

function getActiveTab(cb) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => cb(tabs[0]));
}

// Content scripts are NOT injected into tabs that were already open when the
// extension was installed or reloaded. Inject on demand so the switch works
// without making the user refresh Coursera.
function ensureInjected(tab, cb) {
  if (!tab || !isCourseraUrl(tab.url)) { cb(false); return; }
  chrome.scripting.executeScript(
    { target: { tabId: tab.id, allFrames: true }, files: ['content.js'] },
    () => cb(!chrome.runtime.lastError)
  );
}

// ── Push settings ─────────────────────────────────────────────
// Storage is the source of truth (content.js listens for changes). Writes are
// debounced because chrome.storage.sync allows only ~120 writes/minute and the
// slider fires an event on every pixel of drag.
let saveTimer = null;
function push() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.sync.set(settings), 250);

  // Also message the tab directly for an instant response.
  getActiveTab((tab) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: 'UPDATE_SETTINGS', settings }, () => {
      if (!chrome.runtime.lastError) { setTimeout(pollStatus, 300); return; }
      ensureInjected(tab, (ok) => {
        if (!ok) { footerNote.textContent = '⚠ Open a Coursera tab first'; return; }
        chrome.tabs.sendMessage(tab.id, { type: 'UPDATE_SETTINGS', settings }, () => {
          void chrome.runtime.lastError;
          setTimeout(pollStatus, 300);
        });
      });
    });
  });
}

// ── Poll content script for live video status ─────────────────
function pollStatus() {
  getActiveTab((tab) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        videoDot.className    = 'dot';
        videoInfo.textContent = isCourseraUrl(tab.url) ? 'Connecting to page…' : 'Not a Coursera tab';
        return;
      }
      const s = resp.status || {};
      if (s.hasVideo) {
        videoDot.className = 'dot live';
        const pct = s.videoDuration ? Math.round((s.videoTime / s.videoDuration) * 100) : 0;
        videoInfo.textContent = `Playing at ${s.videoSpeed}× — ${pct}% done`;
        footerNote.textContent = settings.enabled ? 'Autopilot active ✓' : 'Autopilot is off';
      } else {
        videoDot.className = 'dot';
        const type = s.pageType || 'unknown';
        videoInfo.textContent = type === 'assignment'
          ? (settings.skipAssignments ? '⏭ Assignment page — will skip' : 'Assignment page')
          : type === 'reading'
          ? '📖 Reading page'
          : 'No video on this page';
        footerNote.textContent = settings.enabled ? 'Autopilot watching…' : 'Navigate to a lecture';
      }
    });
  });
}

// ── Event listeners ───────────────────────────────────────────
enabledToggle.addEventListener('change', () => {
  settings.enabled = enabledToggle.checked;
  updateEnabledUI(settings.enabled);
  push();
});

speedRange.addEventListener('input', () => {
  settings.videoSpeed = parseFloat(speedRange.value);
  updateSpeedUI(settings.videoSpeed);
  push();
});

presets.forEach(p => {
  p.addEventListener('click', () => {
    settings.videoSpeed = parseFloat(p.dataset.speed);
    updateSpeedUI(settings.videoSpeed);
    push();
  });
});

autoAdvanceToggle.addEventListener('change', () => {
  settings.autoAdvance = autoAdvanceToggle.checked;
  updateOptionRow('autoAdvance', settings.autoAdvance);
  push();
});

smartSkipToggle.addEventListener('change', () => {
  settings.smartSkip = smartSkipToggle.checked;
  updateOptionRow('smartSkip', settings.smartSkip);
  push();
});

skipAssignmentsToggle.addEventListener('change', () => {
  settings.skipAssignments = skipAssignmentsToggle.checked;
  updateOptionRow('skipAssignments', settings.skipAssignments);
  push();
});

autoDismissToggle.addEventListener('change', () => {
  settings.dismissPopups = autoDismissToggle.checked;
  updateOptionRow('autoDismiss', settings.dismissPopups);
  push();
});

refreshBtn.addEventListener('click', pollStatus);

// Flush a pending debounced write if the popup closes mid-drag.
window.addEventListener('pagehide', () => {
  if (saveTimer) { clearTimeout(saveTimer); chrome.storage.sync.set(settings); }
});

// ── Init ──────────────────────────────────────────────────────
chrome.storage.sync.get(DEFAULTS, (saved) => {
  settings = { ...DEFAULTS, ...saved };

  enabledToggle.checked         = settings.enabled;
  autoAdvanceToggle.checked     = settings.autoAdvance;
  smartSkipToggle.checked       = settings.smartSkip;
  skipAssignmentsToggle.checked = settings.skipAssignments;
  autoDismissToggle.checked     = settings.dismissPopups;

  updateSpeedUI(settings.videoSpeed);
  updateEnabledUI(settings.enabled);
  updateOptionRow('autoAdvance',     settings.autoAdvance);
  updateOptionRow('smartSkip',       settings.smartSkip);
  updateOptionRow('skipAssignments', settings.skipAssignments);
  updateOptionRow('autoDismiss',     settings.dismissPopups);

  // Make sure the page has the script (handles tabs opened before install/reload).
  getActiveTab((tab) => {
    chrome.tabs.sendMessage(tab?.id ?? -1, { type: 'GET_STATUS' }, () => {
      if (chrome.runtime.lastError) ensureInjected(tab, () => pollStatus());
      else pollStatus();
    });
  });
  setInterval(pollStatus, 3000);
});
