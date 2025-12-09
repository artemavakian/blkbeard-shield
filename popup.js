// Popup script for the blkbeard extension

const BASE_URL = "https://api.blkbeard.ai";
const FREEMIUS_PRODUCT_ID = 22220;
const PLAN_TITLE = "Full Access";

const toggleButton = document.getElementById("toggleButton");
const buttonText = document.getElementById("buttonText");
const markSpamButton = document.getElementById("markSpamButton");
const falsePositiveButton = document.getElementById("falsePositiveButton");
const proButton = document.getElementById("proButton");
const proText = document.querySelector(".pro-text");
const trialText = document.getElementById("trialText");
const initialScreen = document.getElementById("initialScreen");
const mainMenu = document.getElementById("mainMenu");
const startTrialButton = document.getElementById("startTrialButton");

let currentStatus = null;
let currentEmail = null;

// Load the current enabled state from storage
async function loadState() {
  const result = await chrome.storage.local.get({ enabled: true });
  updateUI(result.enabled);
}

// Update the UI based on the enabled state
function updateUI(enabled) {
  if (enabled) {
    buttonText.textContent = "Turn Off";
    toggleButton.classList.remove("disabled");
  } else {
    buttonText.textContent = "Turn On";
    toggleButton.classList.add("disabled");
  }
}

function showInitialScreen() {
  if (initialScreen) initialScreen.style.display = "block";
  if (mainMenu) mainMenu.style.display = "none";
}

function showMainMenu() {
  if (initialScreen) initialScreen.style.display = "none";
  if (mainMenu) mainMenu.style.display = "flex";
}

// Toggle the extension state
if (toggleButton) {
  toggleButton.addEventListener("click", async () => {
    const result = await chrome.storage.local.get({ enabled: true });
    const newState = !result.enabled;

    await chrome.storage.local.set({ enabled: newState });
    updateUI(newState);

    chrome.runtime.sendMessage({ type: "toggle-enabled", enabled: newState });
  });
}

// Mark current site as spam
if (markSpamButton) {
  markSpamButton.addEventListener("click", async () => {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) {
        return;
      }
      let domain = "";
      try {
        domain = new URL(tab.url).hostname;
      } catch {
        domain = "";
      }
      if (!domain) return;

      chrome.runtime.sendMessage({
        type: "mark-spam",
        domain,
        url: tab.url
      });
    } catch (e) {
      // Ignore errors.
    }
  });
}

// Handle False Positive: reopen last auto-closed tab and mark its domain as safe.
if (falsePositiveButton) {
  falsePositiveButton.addEventListener("click", () => {
    chrome.runtime.sendMessage({
      type: "false-positive"
    });
  });
}

// ---------- Payment & status integration ----------

async function getOrCreateDeviceId() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ blk_device_id: null }, (items) => {
      if (items.blk_device_id) {
        resolve(items.blk_device_id);
        return;
      }
      const array = new Uint8Array(16);
      crypto.getRandomValues(array);
      const uuid = Array.from(array)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      chrome.storage.sync.set({ blk_device_id: uuid }, () => resolve(uuid));
    });
  });
}

async function blkGetToken() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ blk_token: null }, (items) => {
      resolve(items.blk_token);
    });
  });
}

async function blkSetToken(token) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ blk_token: token }, () => resolve());
  });
}

async function blkLoginOrStartTrial(email) {
  const deviceId = await getOrCreateDeviceId();

  const resp = await fetch(`${BASE_URL}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, device_id: deviceId })
  });

  const data = await resp.json();

  if (!resp.ok) {
    if (data.error === "device_limit_exceeded") {
      alert("This account is already in use on too many devices.");
    } else if (data.error === "device_trial_used") {
      alert("Free trial has already been used on this device.");
    } else {
      alert("Login failed. Please try again.");
    }
    return null;
  }

  if (data.token) {
    await blkSetToken(data.token);
  }

  currentEmail = email;
  return data;
}

async function blkCheckStatus() {
  const token = await blkGetToken();
  if (!token) {
    return null;
  }

  try {
    const url = `${BASE_URL}/api/status?token=${encodeURIComponent(token)}`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (!resp.ok) {
      if (data.error === "invalid_token") {
        chrome.storage.sync.remove("blk_token");
      }
      return null;
    }

    return data;
  } catch (e) {
    return null;
  }
}

function buildFreemiusCheckoutUrl(email) {
  const params = new URLSearchParams({
    product_id: String(FREEMIUS_PRODUCT_ID),
    plan_title: PLAN_TITLE,
    email
  });
  return `https://checkout.freemius.com/checkout?${params.toString()}`;
}

function openSubscribePage(email) {
  const url = buildFreemiusCheckoutUrl(email);
  chrome.tabs.create({ url });
}

function updateStatusUI(status) {
  currentStatus = status;

  if (!trialText || !proButton || !proText) return;

  if (!status) {
    // No status -> leave default text (e.g., Free Trial Expired)
    return;
  }

  const { subscription_status, trial_days_remaining, email } = status;
  if (email) {
    currentEmail = email;
  }

  if (subscription_status === "active") {
    proText.textContent = "Active";
    proButton.disabled = true;
    proButton.style.cursor = "default";
  } else {
    proText.textContent = "Go Pro $2.99";
    proButton.disabled = false;
    proButton.style.cursor = "pointer";
  }

  if (subscription_status === "trial" && trial_days_remaining > 0) {
    const days = trial_days_remaining;
    const label = days === 1 ? "1 Day Left" : `${days} Days Left`;
    trialText.textContent = `Free Trial: ${label}`;
  } else if (subscription_status === "active") {
    trialText.textContent = "Subscribed";
  } else {
    trialText.textContent = "Free Trial Expired";
  }
}

if (proButton && proText) {
  proButton.addEventListener("click", async () => {
    // If already active, do nothing.
    if (proText.textContent === "Active") {
      return;
    }

    const email = currentEmail;
    if (!email) {
      // No known email (trial not started yet) -> ignore click.
      return;
    }

    // Ensure backend knows this email/device (starts trial if needed).
    const loginResult = await blkLoginOrStartTrial(email);
    if (!loginResult) {
      return;
    }

    // Open Freemius checkout
    openSubscribePage(email);
  });
}

if (startTrialButton) {
  startTrialButton.addEventListener("click", async () => {
    let email = currentEmail;
    if (!email) {
      email = prompt("Enter your email to start your trial:");
      if (!email) return;
      email = email.trim();
    }

    const loginResult = await blkLoginOrStartTrial(email);
    if (!loginResult) {
      return;
    }

    const status = (await blkCheckStatus()) || {
      email,
      subscription_status: loginResult.subscription_status || "trial",
      trial_days_remaining: loginResult.trial_days_remaining ?? 0,
      devices: [],
      devices_count: 0
    };

    showMainMenu();
    updateStatusUI(status);
  });
}

// ---------- Initialize the popup ----------

loadState();

blkCheckStatus().then((status) => {
  if (!status) {
    // No token / no status yet -> first-run screen.
    showInitialScreen();
  } else {
    showMainMenu();
    updateStatusUI(status);
  }
});

