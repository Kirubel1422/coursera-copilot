// Coursera Autopilot — background.js  v1.3
// Now actually registered in manifest.json (it was never loaded before).
const DEFAULTS = {
  enabled: false,
  videoSpeed: 16,
  autoAdvance: true,
  smartSkip: true,
  skipAssignments: true,
  dismissPopups: true,
};

// Fill in missing keys only — don't wipe the user's settings on every update.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (saved) => {
    chrome.storage.sync.set({ ...DEFAULTS, ...saved });
  });
});
