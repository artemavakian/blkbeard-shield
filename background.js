// Background service worker (Manifest V3, module).
// Evaluates the three conditions and closes tabs when:
// Condition 1 (fake / no real user gesture) AND (Condition 2 OR Condition 3).

import { matchesSpamWordlists, urlHasAffiliateParams } from "./utils.js";

// Timestamp (ms) of last real user gesture observed anywhere.
let lastUserGesture = 0;

// Track the currently active tab and window focus to help evaluate Condition 1.
let currentActiveTabId = null;
let windowFocused = true;

// Track whether the extension is enabled or disabled
let extensionEnabled = true;

// Track a stable installation ID for this browser profile.
let installationId = null;

// Track tabs that were suspicious at creation time (Condition 1 true).
// Map<tabId, { condition1: boolean, condition2: boolean, condition3: boolean, scanRequested: boolean, aiRequested: boolean }>
const suspiciousTabs = new Map();

// Track overlay suspicion score per tab (in the opener tab where the overlay exists).
// Map<tabId, number>
const overlayScores = new Map();

// Track tabs that have trusted typed navigations (omnibox / address-bar).
// Map<tabId, boolean>
const trustedTypedNavigation = new Map();

// Track recent clicks on very suspicious, nearly transparent full-screen overlays.
// Map<tabId, number> (timestamp of last hard overlay click)
const hardOverlayClicks = new Map();

// Track last known URL per tab for same-site checks.
// Map<tabId, string>
const latestTabUrls = new Map();

// Track tabs that should never be auto-closed because they are same-site
// navigations from their opener (e.g., futbin internal links).
// Map<tabId, boolean>
const sameSiteAllowedTabs = new Map();

// Track domains explicitly marked as spam by the user via the popup.
const blockedDomains = new Set();

// Track domains explicitly marked as safe (false positives).
const safeDomains = new Set();

// Remember the most recently auto-closed tab for "False Positive" reopen.
let lastClosedTab = null;

// Initialize enabled state, installation ID, and domain lists from storage.
chrome.storage.local.get(
  { enabled: true, installationId: null, blockedDomains: [], safeDomains: [] },
  (result) => {
    extensionEnabled = result.enabled;

    if (result.installationId) {
      installationId = result.installationId;
    } else {
      try {
        const id =
          (crypto && crypto.randomUUID && crypto.randomUUID()) ||
          `${Math.random().toString(36).slice(2)}-${Date.now()}`;
        installationId = id;
        chrome.storage.local.set({ installationId: id });
      } catch {
        const fallbackId = `${Math.random().toString(36).slice(2)}-${Date.now()}`;
        installationId = fallbackId;
        chrome.storage.local.set({ installationId: fallbackId });
      }
    }

    if (Array.isArray(result.blockedDomains)) {
      result.blockedDomains.forEach((d) => {
        if (d && typeof d === "string") {
          blockedDomains.add(d.toLowerCase());
        }
      });
    }

    if (Array.isArray(result.safeDomains)) {
      result.safeDomains.forEach((d) => {
        if (d && typeof d === "string") {
          safeDomains.add(d.toLowerCase());
        }
      });
    }
  }
);

function persistBlockedDomains() {
  chrome.storage.local.set({ blockedDomains: Array.from(blockedDomains) });
}

function persistSafeDomains() {
  chrome.storage.local.set({ safeDomains: Array.from(safeDomains) });
}

function isTrustedTypedTab(tabId) {
  return trustedTypedNavigation.get(tabId) === true;
}

function isSearchEngineUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return (
      host === "www.google.com" ||
      host === "google.com" ||
      host === "www.bing.com" ||
      host === "bing.com" ||
      host === "duckduckgo.com" ||
      host === "www.duckduckgo.com"
    );
  } catch {
    return false;
  }
}

function getHostname(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function areSameSiteUrls(urlA, urlB) {
  const hostA = getHostname(urlA);
  const hostB = getHostname(urlB);
  if (!hostA || !hostB) return false;

  if (hostA === hostB) return true;

  // Treat methstreams and crackstreams as the same logical site, even across
  // different subdomains or TLDs (e.g., methstreams.com, crackstreams.is, etc.)
  const isStreamsHost = (host) =>
    host.includes("methstreams") || host.includes("crackstreams");

  if (isStreamsHost(hostA) && isStreamsHost(hostB)) {
    return true;
  }

  return false;
}

async function reportSpamToBackend(payload) {
  try {
    await fetch("https://api.blkbeard.ai/api/report-spam", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    // Best-effort only; ignore failures.
  }
}

function closeTabWithTracking(tabId, knownUrl) {
  (async () => {
    try {
      let url = knownUrl || "";
      if (!url) {
        const tab = await chrome.tabs.get(tabId);
        url = getTabUrl(tab);
      }

      const host = getHostname(url);
      if (host && safeDomains.has(host)) {
        // Domain marked as safe; do not close.
        return;
      }

      if (url) {
        lastClosedTab = {
          url,
          domain: host || ""
        };
      } else {
        lastClosedTab = null;
      }

      await chrome.tabs.remove(tabId);
    } catch (e) {
      // Ignore errors (tab may already be gone, etc.).
    }
  })();
}

function getTabUrl(tab) {
  if (!tab) return "";
  return tab.pendingUrl || tab.url || "";
}

function evaluateCondition1(tab) {
  // Condition 1: the tab was opened via a false user gesture.

  // If this tab has a trusted typed navigation, do not treat it as suspicious.
  if (tab && typeof tab.id === "number" && isTrustedTypedTab(tab.id)) {
    return false;
  }

  // 1) If tab.openerTabId exists but is not equal to the currently active tab, treat as suspicious.
  let openerSuspicious = false;
  if (typeof tab.openerTabId === "number") {
    if (currentActiveTabId !== null && tab.openerTabId !== currentActiveTabId) {
      openerSuspicious = true;
    }
  }

  // 2) If the browser window is not focused when the tab is created, treat as suspicious.
  const unfocusedSuspicious = !windowFocused;

  // 3) If Date.now() - lastUserGesture > 500 ms, treat as suspicious.
  const now = Date.now();
  const gestureSuspicious =
    lastUserGesture > 0 ? now - lastUserGesture > 500 : false;

  // 4) If the opener tab has a highly suspicious full-screen overlay, treat as suspicious.
  let overlaySuspicious = false;
  if (typeof tab.openerTabId === "number") {
    const score = overlayScores.get(tab.openerTabId) || 0;
    if (score >= 3) {
      overlaySuspicious = true;
    }
  }

  return (
    openerSuspicious || unfocusedSuspicious || gestureSuspicious || overlaySuspicious
  );
}

function maybeCloseTabIfRulesMatch(tabId, record) {
  if (!record || !record.condition1) {
    return;
  }

  if (record.condition2 || record.condition3) {
    // Condition 1 AND (Condition 2 OR Condition 3) -> close.
    closeTabWithTracking(tabId);
  }
}

async function classifyWithBackend(payload) {
  try {
    const response = await fetch("https://api.blkbeard.ai/api/classify", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    return {
      gambling: !!data.gambling,
      adult: !!data.adult,
      fakeSoftware: !!data.fakeSoftware,
      genericScam: !!data.genericScam,
      ageGate: !!data.ageGate
    };
  } catch (e) {
    return null;
  }
}

async function handlePageScanResult(message, sender) {
  const tabId = sender?.tab?.id;
  if (!tabId) return;

  // Never auto-close tabs that come from trusted typed navigations.
  if (isTrustedTypedTab(tabId)) {
    return;
  }

  const record = suspiciousTabs.get(tabId);
  if (!record) {
    // If we never classified this tab as suspicious at creation time,
    // we must NOT close based solely on content or URL.
    return;
  }

  const url = message.url || getTabUrl(sender.tab);
  const title = message.title || "";
  const metaDescription = message.metaDescription || "";
  const textContent = message.textContent || "";

  const isSearchEngine = isSearchEngineUrl(url);

  // First, try to satisfy Condition 2 using fast local wordlists (URL + content),
  // but never treat major search engines as spam based on wordlists alone.
  const condition2FromWordlists = isSearchEngine
    ? false
    : matchesSpamWordlists({
        url,
        title,
        metaDescription,
        textContent
      });

  // Condition 3 can also be evaluated from the final resolved URL.
  const condition3FromUrl = urlHasAffiliateParams(url);

  if (condition2FromWordlists) {
    record.condition2 = true;
    record.condition3 = record.condition3 || condition3FromUrl;
    maybeCloseTabIfRulesMatch(tabId, record);
    return;
  }

  // If wordlists didn't trigger Condition 2, fall back to the AI classifier.
  let condition2FromAI = false;

  if (!isSearchEngine) {
    const aiVerdict = await classifyWithBackend({
      url,
      title,
      metaDescription,
      textSnippet: textContent
    });

    if (aiVerdict) {
      condition2FromAI =
        aiVerdict.gambling ||
        aiVerdict.adult ||
        aiVerdict.fakeSoftware ||
        aiVerdict.genericScam ||
        aiVerdict.ageGate;
    }
  }

  record.condition2 = condition2FromWordlists || condition2FromAI;
  record.condition3 = record.condition3 || condition3FromUrl;

  maybeCloseTabIfRulesMatch(tabId, record);
}

// Listen for user gestures and other signals reported from content scripts and popup.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "user-gesture") {
    // Update lastUserGesture with a fast in-memory value (no chrome.storage).
    lastUserGesture = Date.now();
  } else if (message.type === "page-scan-result") {
    void handlePageScanResult(message, sender);
  } else if (message.type === "toggle-enabled") {
    // Update the enabled state when toggled from the popup
    extensionEnabled = message.enabled;
  } else if (message.type === "overlay-signal") {
    const tabId = sender?.tab?.id;
    if (typeof tabId === "number") {
      const current = overlayScores.get(tabId) || 0;
      const incoming = Number(message.score) || 0;
      if (incoming > current) {
        overlayScores.set(tabId, incoming);
      }
    }
  } else if (message.type === "hard-overlay-click") {
    const tabId = sender?.tab?.id;
    if (typeof tabId === "number") {
      hardOverlayClicks.set(tabId, Date.now());
    }
  } else if (message.type === "mark-spam") {
    // When extension is disabled, ignore manual spam marking.
    if (!extensionEnabled) {
      return;
    }

    const { domain, url } = message;
    if (!domain || !url) {
      return;
    }

    const normalizedDomain = domain.toLowerCase();
    // Remove from safe list if present; spam marking overrides safe.
    safeDomains.delete(normalizedDomain);
    blockedDomains.add(normalizedDomain);
    persistBlockedDomains();
    persistSafeDomains();

    const payload = {
      domain: normalizedDomain,
      url,
      timestamp: Date.now(),
      userId: installationId || null
    };

    void reportSpamToBackend(payload);
  } else if (message.type === "false-positive") {
    // When extension is disabled, ignore false positive actions.
    if (!extensionEnabled) {
      return;
    }

    if (!lastClosedTab || !lastClosedTab.url) {
      return;
    }

    const domain = lastClosedTab.domain || getHostname(lastClosedTab.url);
    if (!domain) {
      return;
    }

    const normalizedDomain = domain.toLowerCase();
    // Safe list overrides block list for future auto-close decisions.
    blockedDomains.delete(normalizedDomain);
    safeDomains.add(normalizedDomain);
    persistBlockedDomains();
    persistSafeDomains();

    chrome.tabs.create({ url: lastClosedTab.url });
  }
});

// Track trusted typed / address-bar navigations and mark those tabs as safe.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (
    details.transitionType === "typed" ||
    details.transitionType === "generated"
  ) {
    const tabId = details.tabId;
    if (typeof tabId === "number") {
      trustedTypedNavigation.set(tabId, true);
      // Ensure we don't treat this tab as suspicious anymore.
      suspiciousTabs.delete(tabId);
      overlayScores.delete(tabId);
    }
  }
});

// Track active tab for openerTabId comparisons.
chrome.tabs.onActivated.addListener((activeInfo) => {
  currentActiveTabId = activeInfo.tabId;
});

// Track whether any browser window is focused.
chrome.windows.onFocusChanged.addListener((windowId) => {
  windowFocused = windowId !== chrome.windows.WINDOW_ID_NONE;
});

// Evaluate tabs when they are created (Condition 1, 3 from initial URL).
chrome.tabs.onCreated.addListener((tab) => {
  // Skip all logic if extension is disabled
  if (!extensionEnabled) {
    return;
  }

  const initialUrl = getTabUrl(tab);

  // If this tab's domain has been explicitly marked as spam, and it was
  // opened from a click (recent user gesture), close it immediately,
  // regardless of other conditions.
  const host = getHostname(initialUrl);
  if (
    host &&
    blockedDomains.has(host) &&
    typeof tab.openerTabId === "number" &&
    Date.now() - lastUserGesture < 1000
  ) {
    closeTabWithTracking(tab.id, initialUrl);
    return;
  }

  // Same-site whitelist: if the new tab's host matches its opener's host,
  // never auto-close it, regardless of other conditions.
  if (typeof tab.openerTabId === "number") {
    const openerUrl = latestTabUrls.get(tab.openerTabId) || "";
    if (areSameSiteUrls(initialUrl, openerUrl)) {
      sameSiteAllowedTabs.set(tab.id, true);
      return;
    }
  }

  // If this tab was opened immediately after a click on a very suspicious
  // full-screen, nearly transparent overlay in the opener tab, close it
  // unconditionally, regardless of URL or content.
  if (typeof tab.openerTabId === "number") {
    const ts = hardOverlayClicks.get(tab.openerTabId);
    if (ts && Date.now() - ts < 1500) {
      closeTabWithTracking(tab.id, initialUrl);
      return;
    }
  }

  const condition1 = evaluateCondition1(tab);
  if (!condition1) {
    return;
  }

  const condition3 = urlHasAffiliateParams(initialUrl);

  // If Condition 1 AND Condition 3 are already true at creation, close immediately.
  if (condition3) {
    closeTabWithTracking(tab.id, initialUrl);
    return;
  }

  // Otherwise, track this tab as suspicious and wait for content scan.
  suspiciousTabs.set(tab.id, {
    condition1: true,
    condition2: false,
    condition3,
    scanRequested: false,
    aiRequested: false
  });
});

// React to URL changes and load completion for suspicious tabs.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Skip all logic if extension is disabled or this is a trusted typed tab.
  if (!extensionEnabled || isTrustedTypedTab(tabId)) {
    return;
  }

  const record = suspiciousTabs.get(tabId);
  if (!record) {
    return;
  }

  if (changeInfo.url) {
    latestTabUrls.set(tabId, changeInfo.url);
  }

  // Re-check Condition 2 (URL-only wordlists) and Condition 3 when URL changes.
  if (changeInfo.url) {
    // Do not treat search engine hosts as spam based on wordlists or affiliate params.
    if (isSearchEngineUrl(changeInfo.url)) {
      return;
    }

    // Condition 2: fast URL-only keyword scan.
    const condition2FromUrlOnly = matchesSpamWordlists({
      url: changeInfo.url
    });

    if (condition2FromUrlOnly) {
      record.condition2 = true;
      maybeCloseTabIfRulesMatch(tabId, record);
      if (!suspiciousTabs.has(tabId)) {
        return;
      }
    }

    // Condition 3: affiliate / tracking params.
    if (urlHasAffiliateParams(changeInfo.url)) {
      record.condition3 = true;
      maybeCloseTabIfRulesMatch(tabId, record);
      if (!suspiciousTabs.has(tabId)) {
        return;
      }
    }
  }

  // Once the tab finishes loading, request a lightweight page scan via content script.
  if (changeInfo.status === "complete" && !record.scanRequested) {
    record.scanRequested = true;
    chrome.tabs.sendMessage(
      tabId,
      { type: "extract-page-scan" },
      () => {
        // Ignore errors (e.g., if content script cannot run on this URL).
        void chrome.runtime.lastError;
      }
    );
  }
});

// Clean up tracking maps when tabs are closed.
chrome.tabs.onRemoved.addListener((tabId) => {
  suspiciousTabs.delete(tabId);
  overlayScores.delete(tabId);
  trustedTypedNavigation.delete(tabId);
  hardOverlayClicks.delete(tabId);
  latestTabUrls.delete(tabId);
  sameSiteAllowedTabs.delete(tabId);
});



