// Coursera Autopilot — content.js  v1.3
(function () {
  "use strict";

  // The popup may inject this file into tabs that were open before the
  // extension was installed/reloaded — never run twice in the same frame.
  // (An orphaned copy from before an extension reload doesn't count.)
  try { if (window.__courseraAutopilotAlive && window.__courseraAutopilotAlive()) return; } catch {}
  window.__courseraAutopilotAlive = () => !orphaned();

  const IS_TOP = window === window.top;
  const MIN_RATE = 0.0625; // Chrome's allowed playbackRate range
  const MAX_RATE = 16;

  // Same keys as popup.js / background.js (they used to disagree).
  const DEFAULTS = {
    enabled: false,
    videoSpeed: 16,
    autoAdvance: true,
    smartSkip: true,
    skipAssignments: true,
    dismissPopups: true,
  };

  let settings = { ...DEFAULTS };
  let running = false;
  let enforceTimer = null;
  let advanceTimer = null;
  let popupTimer = null;
  let isAdvancing = false;

  const attached = new WeakSet();    // videos we've added listeners to (once per element)
  const skippedSrc = new WeakMap();  // video -> src we already smart-skipped

  // After the extension is reloaded/updated, the old copy of this script keeps
  // running in open tabs ("orphaned") with a dead chrome.runtime. Make it stand
  // down so it doesn't fight the fresh copy over the playback rate.
  function orphaned() {
    try { return !chrome.runtime?.id; } catch { return true; }
  }
  function retireIfOrphaned() {
    if (!orphaned()) return false;
    running = false;
    clearInterval(enforceTimer);
    clearTimeout(advanceTimer);
    clearInterval(popupTimer);
    return true;
  }

  // ── Settings plumbing ─────────────────────────────────────────
  function applySettings(next) {
    settings = { ...DEFAULTS, ...settings, ...next };
    if (settings.enabled) start(); else stop();
  }

  chrome.storage.sync.get(DEFAULTS, (saved) => applySettings(saved));

  // Works even when the popup's message can't reach us (or reaches only some frames).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const next = {};
    for (const k of Object.keys(changes)) next[k] = changes[k].newValue;
    applySettings(next);
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "UPDATE_SETTINGS") {
      applySettings(msg.settings);
      sendResponse({ ok: true });
    } else if (msg.type === "GET_STATUS") {
      // Only the top frame or a frame that actually has the player answers.
      if (!IS_TOP && !document.querySelector("video")) return;
      sendResponse({ status: getStatus() });
    }
  });

  function getStatus() {
    const video = document.querySelector("video");
    return {
      hasVideo: !!video,
      videoTime: video ? Math.round(video.currentTime) : 0,
      videoDuration: video && isFinite(video.duration) ? Math.round(video.duration) : 0,
      videoSpeed: video ? video.playbackRate : 1,
      pageType: detectPageType(),
    };
  }

  // ── Start / Stop ──────────────────────────────────────────────
  function start() {
    running = true;
    applyToAllVideos();               // re-applies the CURRENT speed every time
    clearInterval(enforceTimer);
    enforceTimer = setInterval(applyToAllVideos, 1000); // backstop
    if (IS_TOP) {
      if (settings.dismissPopups) scheduleDismissPopups(); else clearInterval(popupTimer);
      whenDomReady(() => scheduleAutoAdvance());
    }
  }

  function stop() {
    if (!running) return;
    running = false;
    clearInterval(enforceTimer);
    clearTimeout(advanceTimer);
    clearInterval(popupTimer);
    document.querySelectorAll("video").forEach((v) => {
      v.defaultPlaybackRate = 1;
      v.playbackRate = 1;
    });
  }

  // ── VIDEO SPEED ───────────────────────────────────────────────
  function targetRate() {
    const r = Number(settings.videoSpeed);
    if (!isFinite(r)) return 1;
    return Math.min(MAX_RATE, Math.max(MIN_RATE, r));
  }

  function setRate(video) {
    const r = targetRate();
    try {
      if (video.defaultPlaybackRate !== r) video.defaultPlaybackRate = r;
      if (video.playbackRate !== r) video.playbackRate = r;
    } catch (e) {
      console.warn("[Autopilot] Could not set playbackRate:", e);
    }
  }

  function applyToAllVideos() {
    if (retireIfOrphaned()) return;
    document.querySelectorAll("video").forEach((v) => {
      attach(v);
      if (running) setRate(v);
    });
  }

  // Capture-phase guard on window, registered at document_start so it runs
  // before Coursera's own player handlers. While Autopilot is on, the player
  // never sees ratechange events, so it can't keep resetting the speed back
  // to its menu value (the old code just fought it in a ratechange ping-pong).
  window.addEventListener(
    "ratechange",
    (e) => {
      const v = e.target;
      if (!running || !(v instanceof HTMLMediaElement)) return;
      if (retireIfOrphaned()) return;
      e.stopImmediatePropagation();
      if (v.playbackRate !== targetRate()) setRate(v);
    },
    true
  );

  function attach(video) {
    if (attached.has(video)) return;
    attached.add(video);

    const kick = () => {
      if (!running) return;
      setRate(video);
      if (video.paused && !video.ended && !document.hidden) video.play().catch(() => {});
    };
    // A new source resets playbackRate to defaultPlaybackRate — re-apply.
    video.addEventListener("loadedmetadata", kick);
    video.addEventListener("play", () => running && setRate(video));

    // Smart Skip: after 20 s of video-time, jump to near the end (once per source).
    video.addEventListener("timeupdate", () => {
      if (!running || !settings.smartSkip) return;
      const src = video.currentSrc || video.src;
      if (skippedSrc.get(video) === src) return;
      if (video.currentTime >= 20 && isFinite(video.duration) && video.duration > 25) {
        skippedSrc.set(video, src);
        console.log("[Autopilot] Smart Skip — jumping to end");
        video.currentTime = video.duration - 1.5;
      }
    });

    video.addEventListener("ended", () => {
      if (running && settings.autoAdvance) {
        setTimeout(() => advanceToNext("video-ended"), 1000);
      }
    });

    // Don't let Coursera keep the video paused (but never restart a finished one)
    video.addEventListener("pause", () => {
      if (!running || document.hidden || video.ended) return;
      setTimeout(() => {
        if (running && video.paused && !video.ended) video.play().catch(() => {});
      }, 300);
    });

    if (video.readyState >= 1) kick();
  }

  // Catch the player whenever Coursera's SPA mounts it.
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === "VIDEO") { attach(node); if (running) setRate(node); }
        node.querySelectorAll?.("video").forEach((v) => { attach(v); if (running) setRate(v); });
      }
    }
    if (IS_TOP) checkNavigation();
  }).observe(document, { childList: true, subtree: true });

  // ── Page-type detection ───────────────────────────────────────
  function detectPageType() {
    const url = window.location.href;
    if (/\/lecture\//.test(url))               return "video";
    if (/\/supplement\//.test(url))            return "reading";
    if (/\/assignment-submission\//.test(url)) return "assignment";
    if (/\/quiz\//.test(url))                  return "assignment";
    if (/\/exam\//.test(url))                  return "assignment";
    if (/\/programming\//.test(url))           return "assignment";
    if (/\/gradedLti\//.test(url))             return "assignment";
    if (/\/ungradedLti\//.test(url))           return "assignment";
    if (/\/gradedWidget\//.test(url))          return "assignment";
    if (/\/peer\//.test(url))                  return "peer";
    return "other";
  }

  // ── SPA navigation ────────────────────────────────────────────
  let lastUrl = location.href;
  function checkNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    console.log("[Autopilot] Navigation →", lastUrl);
    isAdvancing = false;
    clearTimeout(advanceTimer);
    if (!running) return;
    // Listeners stay attached (no duplicates); just re-apply and reschedule.
    setTimeout(() => {
      applyToAllVideos();
      if (settings.dismissPopups) dismissPopups();
      scheduleAutoAdvance();
    }, 1500);
  }

  // ── AUTO ADVANCE ──────────────────────────────────────────────
  function scheduleAutoAdvance() {
    clearTimeout(advanceTimer);
    if (!running || !settings.autoAdvance) return;
    const pageType = detectPageType();

    if (pageType === "assignment" && settings.skipAssignments) {
      advanceTimer = setTimeout(() => advanceToNext("skip-assignment"), 1500);
    } else if (pageType === "reading" || pageType === "peer") {
      advanceTimer = setTimeout(markCompleteAndAdvance, 3000);
    } else if (pageType === "video") {
      // Safety net for lecture pages with no detectable video element
      advanceTimer = setTimeout(() => {
        if (!document.querySelector("video")) advanceToNext("no-video-fallback");
      }, 5000);
    }
  }

  function markCompleteAndAdvance() {
    if (isAdvancing || !running) return;
    const completeBtn = findButton(["Mark as Complete", "Mark Complete", "I'm done"]);
    if (completeBtn) {
      completeBtn.click();
      setTimeout(() => advanceToNext("mark-complete"), 1000);
    } else {
      advanceToNext("auto-advance");
    }
  }

  function advanceToNext(reason) {
    if (!IS_TOP) return; // Next button lives in the top frame
    if (isAdvancing || !running) return;
    isAdvancing = true;
    console.log("[Autopilot] advanceToNext —", reason);

    if (clickNextButton()) {
      setTimeout(() => { isAdvancing = false; }, 3500);
    } else {
      console.log("[Autopilot] No next button found — retrying in 2 s");
      isAdvancing = false;
      setTimeout(() => {
        if (!isAdvancing && running && settings.autoAdvance) clickNextButton();
      }, 2000);
    }
  }

  function clickNextButton() {
    const directSelectors = [
      'button[aria-label="Go to next item"]',
      'a[aria-label="Go to next item"]',
      '[data-e2e="next-item-btn"]',
      '[data-testid="next-item-button"]',
      'button[aria-label="Next Item"]',
      'a[aria-label="Next Item"]',
      '[data-track-component="next_item"]',
      '.rc-NextButton button',
      '.rc-NextButton a',
      '.rc-WeekNavigationItem--next a',
    ];
    for (const sel of directSelectors) {
      const btn = document.querySelector(sel);
      if (btn && isVisible(btn)) {
        console.log("[Autopilot] Clicking:", sel);
        btn.click();
        return true;
      }
    }
    const textLabels = ["next", "continue", "next item", "next lesson", "go to next item"];
    for (const btn of document.querySelectorAll("button, a[href], a[role='button'], .cds-button-label")) {
      const t = btn.textContent.trim().toLowerCase();
      if (textLabels.includes(t) && isVisible(btn)) {
        console.log("[Autopilot] Text-label click:", btn.textContent.trim());
        btn.click();
        return true;
      }
    }
    return false;
  }

  // ── POPUP DISMISSAL ───────────────────────────────────────────
  function scheduleDismissPopups() {
    clearInterval(popupTimer);
    whenDomReady(dismissPopups);
    popupTimer = setInterval(dismissPopups, 1800);
  }

  function dismissPopups() {
    if (!running || !settings.dismissPopups || !document.body) return;
    const closeSelectors = [
      '[data-e2e="close-dialog-button"]',
      '[aria-label="Close"]',
      '.rc-DialogFooter button:last-child',
      '.rc-InterstitialDialog button',
      '[data-testid="close-modal"]',
      '.cds-Modal-closeButton',
      'button[aria-label="dismiss"]',
      '.rc-NotificationBanner button',
    ];
    for (const sel of closeSelectors) {
      const btn = document.querySelector(sel);
      if (btn && isVisible(btn)) btn.click();
    }
    document.querySelectorAll('.rc-Modal button, .cds-Modal button, [role="dialog"] button')
      .forEach((btn) => {
        const t = btn.textContent.trim().toLowerCase();
        if (["ok", "got it", "continue", "i understand", "dismiss", "done"].includes(t) && isVisible(btn))
          btn.click();
      });
  }

  // ── Utils ─────────────────────────────────────────────────────
  function whenDomReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn, { once: true });
    } else {
      fn();
    }
  }

  function findButton(labels) {
    for (const btn of document.querySelectorAll("button, a[role='button'], .cds-button-label")) {
      const t = btn.textContent.trim().toLowerCase();
      if (labels.some((l) => t.includes(l.toLowerCase())) && isVisible(btn)) return btn;
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect(), s = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 &&
           s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
  }
})();
