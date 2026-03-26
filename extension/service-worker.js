importScripts("lib/shared.js");

const {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  deepClone,
  sanitizeStringList,
  normalizeBundle,
  normalizeHost,
  getHostnameFromUrl,
  isTrustedHost
} = globalThis.CenzControlShared;

const pageStatsByTab = new Map();
const SOURCE_CONFIG_PATH = "data/source-config.json";
const PASSWORD_MIN_LENGTH = 4;
const PASSWORD_HASH_ITERATIONS = 120000;
const textEncoder = new TextEncoder();

let activeBundle = null;
let sourceConfigCache = null;
let activeBundleIndex = createBundleIndex({ blockedSites: [] });

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create("cc-refresh-data", {
    periodInMinutes: DEFAULT_SETTINGS.autoUpdateHours * 60
  });
  await chrome.storage.local.remove(STORAGE_KEYS.dataBundle);
  await ensureSettings();
  await ensureBundleLoaded({ forceRefresh: true });
  await reinjectContentScripts();
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create("cc-refresh-data", {
    periodInMinutes: DEFAULT_SETTINGS.autoUpdateHours * 60
  });
  await chrome.storage.local.remove(STORAGE_KEYS.dataBundle);
  await ensureSettings();
  await ensureBundleLoaded({ forceRefresh: false });
  await reinjectContentScripts();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "cc-refresh-data") {
    return;
  }

  await ensureBundleLoaded({ forceRefresh: true });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pageStatsByTab.delete(tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0 || !details.url || isBrowserInternalUrl(details.url)) {
    return;
  }

  void (async () => {
    const decision = await evaluateUrl(details.url);
    if (!decision.blocked) {
      return;
    }

    chrome.tabs.update(details.tabId, { url: buildBlockedPageUrl(details.url, decision.entry) });
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return undefined;
  }

  void (async () => {
    switch (message.type) {
      case "cc:getPageContext": {
        const settings = await getSettings();
        const bundle = await ensureBundleLoaded({ forceRefresh: false });
        const hostname = getHostnameFromUrl(message.url || sender.tab?.url || "");

        sendResponse({
          ok: true,
          settings,
          bundle: createFilteringBundle(bundle),
          isTrusted: isTrustedHost(hostname, settings.trustedSites)
        });
        return;
      }

      case "cc:reportStats": {
        const tabId = sender.tab?.id ?? message.tabId;
        if (typeof tabId === "number") {
          const payload = {
            url: message.url || sender.tab?.url || "",
            host: getHostnameFromUrl(message.url || sender.tab?.url || ""),
            replacedCount: Number(message.stats?.replacedCount || 0),
            scannedNodes: Number(message.stats?.scannedNodes || 0),
            ruleHits: message.stats?.ruleHits || {},
            updatedAt: new Date().toISOString()
          };

          pageStatsByTab.set(tabId, payload);
          chrome.action.setBadgeBackgroundColor({ tabId, color: payload.replacedCount > 0 ? "#bd4f2d" : "#2f7d6f" });
          chrome.action.setBadgeText({ tabId, text: payload.replacedCount > 0 ? String(payload.replacedCount) : "" });
        }

        sendResponse({ ok: true });
        return;
      }

      case "cc:getPopupState": {
        const tabId = Number(message.tabId);
        const url = String(message.url || "");
        const settings = await getSettings();
        const bundle = await ensureBundleLoaded({ forceRefresh: false });
        const lock = await getSettingsLockState();
        const decision = await evaluateUrl(url, settings, bundle);
        const stats = Number.isFinite(tabId) ? pageStatsByTab.get(tabId) || null : null;
        const resolvedSource = await resolveBundleSource(settings);

        sendResponse({
          ok: true,
          settings,
          lock,
          bundleMeta: {
            version: bundle.version,
            updatedAt: bundle.updatedAt,
            checkedAt: bundle.metadata?.checkedAt || null,
            sourceLabel: bundle.metadata?.sourceLabel || "unknown",
            resolvedSourceUrl: resolvedSource.url || "",
            resolvedSourceKind: resolvedSource.kind
          },
          stats,
          decision
        });
        return;
      }

      case "cc:getOptionsState": {
        const settings = await getSettings();
        const bundle = await ensureBundleLoaded({ forceRefresh: false });
        const updateHistory = await getUpdateHistory();
        const sourceConfig = await getSourceConfig(false);
        const resolvedSource = await resolveBundleSource(settings);
        const lock = await getSettingsLockState();

        sendResponse({
          ok: true,
          settings,
          lock,
          sourceConfig,
          bundleMeta: {
            version: bundle.version,
            updatedAt: bundle.updatedAt,
            checkedAt: bundle.metadata?.checkedAt || null,
            sourceLabel: bundle.metadata?.sourceLabel || "unknown",
            dictionarySize: bundle.dictionary.length,
            blockedSitesSize: bundle.blockedSites.length,
            exceptionsSize: bundle.exceptions.length,
            resolvedSourceUrl: resolvedSource.url || "",
            resolvedSourceKind: resolvedSource.kind
          },
          updateHistory
        });
        return;
      }

      case "cc:saveOptions": {
        if (!(await canManageSettings())) {
          sendResponse({ ok: false, error: "Настройки защищены родительским паролем." });
          return;
        }

        const settings = await saveSettings(message.settings || {});
        sendResponse({ ok: true, settings });
        return;
      }

      case "cc:unlockSettings": {
        sendResponse(await unlockSettingsSession(message.password || ""));
        return;
      }

      case "cc:lockSettings": {
        await setSettingsUnlocked(false);
        sendResponse({ ok: true, lock: await getSettingsLockState() });
        return;
      }

      case "cc:setSettingsPassword": {
        sendResponse(await setSettingsPassword(message.currentPassword || "", message.newPassword || ""));
        return;
      }

      case "cc:clearSettingsPassword": {
        sendResponse(await clearSettingsPassword(message.currentPassword || ""));
        return;
      }

      case "cc:forceUpdate": {
        const bundle = await ensureBundleLoaded({ forceRefresh: true });
        const settings = await getSettings();
        const resolvedSource = await resolveBundleSource(settings);

        sendResponse({
          ok: true,
          bundleMeta: {
            version: bundle.version,
            updatedAt: bundle.updatedAt,
            checkedAt: bundle.metadata?.checkedAt || null,
            sourceLabel: bundle.metadata?.sourceLabel || "unknown",
            resolvedSourceUrl: resolvedSource.url || "",
            resolvedSourceKind: resolvedSource.kind
          }
        });
        return;
      }

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    }
  })().catch(async (error) => {
    await appendUpdateHistory({
      checkedAt: new Date().toISOString(),
      sourceLabel: "runtime",
      status: "error",
      details: error.message
    });
    sendResponse({ ok: false, error: error.message });
  });

  return true;
});

async function ensureSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  if (!stored[STORAGE_KEYS.settings]) {
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: deepClone(DEFAULT_SETTINGS)
    });
    return deepClone(DEFAULT_SETTINGS);
  }

  const settings = sanitizeSettings(stored[STORAGE_KEYS.settings]);
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: settings
  });
  return settings;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  return sanitizeSettings(stored[STORAGE_KEYS.settings] || DEFAULT_SETTINGS);
}

async function saveSettings(candidateSettings) {
  const settings = sanitizeSettings(candidateSettings);
  await chrome.storage.local.set({
    [STORAGE_KEYS.settings]: settings
  });
  chrome.alarms.create("cc-refresh-data", {
    periodInMinutes: Math.max(1, settings.autoUpdateHours) * 60
  });
  return settings;
}

function sanitizeSettings(candidateSettings) {
  const raw = candidateSettings && typeof candidateSettings === "object" ? candidateSettings : {};
  const settings = {
    ...deepClone(DEFAULT_SETTINGS),
    ...raw
  };

  settings.filteringEnabled = Boolean(settings.filteringEnabled);
  settings.blockingEnabled = Boolean(settings.blockingEnabled);
  settings.strictness = ["low", "medium", "high"].includes(settings.strictness) ? settings.strictness : DEFAULT_SETTINGS.strictness;
  settings.replacementMode = ["mask", "placeholder", "soft"].includes(settings.replacementMode)
    ? settings.replacementMode
    : DEFAULT_SETTINGS.replacementMode;
  settings.replacementWord = String(settings.replacementWord || DEFAULT_SETTINGS.replacementWord).trim() || DEFAULT_SETTINGS.replacementWord;
  settings.trustedSites = sanitizeStringList(settings.trustedSites, "host");
  settings.customExceptions = sanitizeStringList(settings.customExceptions, "token");
  settings.remoteDataUrl = String(settings.remoteDataUrl || "").trim();
  settings.autoUpdateHours = Number(settings.autoUpdateHours) > 0 ? Number(settings.autoUpdateHours) : DEFAULT_SETTINGS.autoUpdateHours;

  return settings;
}

async function getParentalControl() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.parentalControl);
  return normalizeParentalControl(stored[STORAGE_KEYS.parentalControl]);
}

function normalizeParentalControl(candidate) {
  const input = candidate && typeof candidate === "object" ? candidate : {};

  return {
    passwordHash: String(input.passwordHash || "").trim(),
    passwordSalt: String(input.passwordSalt || "").trim(),
    updatedAt: input.updatedAt || null
  };
}

async function getSettingsLockState() {
  const parentalControl = await getParentalControl();
  const enabled = Boolean(parentalControl.passwordHash && parentalControl.passwordSalt);
  if (!enabled) {
    return {
      enabled: false,
      unlocked: true,
      updatedAt: parentalControl.updatedAt
    };
  }

  const stored = await chrome.storage.session.get(STORAGE_KEYS.settingsUnlocked);
  return {
    enabled: true,
    unlocked: Boolean(stored[STORAGE_KEYS.settingsUnlocked]),
    updatedAt: parentalControl.updatedAt
  };
}

async function canManageSettings() {
  const lock = await getSettingsLockState();
  return !lock.enabled || lock.unlocked;
}

async function setSettingsUnlocked(unlocked) {
  if (unlocked) {
    await chrome.storage.session.set({
      [STORAGE_KEYS.settingsUnlocked]: true
    });
    return;
  }

  await chrome.storage.session.remove(STORAGE_KEYS.settingsUnlocked);
}

async function unlockSettingsSession(password) {
  const parentalControl = await getParentalControl();
  if (!parentalControl.passwordHash || !parentalControl.passwordSalt) {
    await setSettingsUnlocked(true);
    return {
      ok: true,
      lock: await getSettingsLockState()
    };
  }

  const isValid = await verifyPassword(password, parentalControl);
  if (!isValid) {
    return {
      ok: false,
      error: "Неверный пароль."
    };
  }

  await setSettingsUnlocked(true);
  return {
    ok: true,
    lock: await getSettingsLockState()
  };
}

async function setSettingsPassword(currentPassword, newPassword) {
  const password = String(newPassword || "");
  if (password.length < PASSWORD_MIN_LENGTH) {
    return {
      ok: false,
      error: `Пароль должен содержать минимум ${PASSWORD_MIN_LENGTH} символа.`
    };
  }

  const parentalControl = await getParentalControl();
  const alreadyProtected = Boolean(parentalControl.passwordHash && parentalControl.passwordSalt);
  if (alreadyProtected) {
    const canChange = await canManageSettings();
    if (!canChange) {
      return {
        ok: false,
        error: "Сначала разблокируйте настройки текущим паролем."
      };
    }

    if (!currentPassword || !(await verifyPassword(currentPassword, parentalControl))) {
      return {
        ok: false,
        error: "Текущий пароль указан неверно."
      };
    }
  }

  const passwordSalt = generateSaltHex();
  const passwordHash = await derivePasswordHash(password, passwordSalt);
  await chrome.storage.local.set({
    [STORAGE_KEYS.parentalControl]: {
      passwordHash,
      passwordSalt,
      updatedAt: new Date().toISOString()
    }
  });
  await setSettingsUnlocked(true);

  return {
    ok: true,
    lock: await getSettingsLockState()
  };
}

async function clearSettingsPassword(currentPassword) {
  const parentalControl = await getParentalControl();
  if (!parentalControl.passwordHash || !parentalControl.passwordSalt) {
    return {
      ok: true,
      lock: await getSettingsLockState()
    };
  }

  const canChange = await canManageSettings();
  if (!canChange) {
    return {
      ok: false,
      error: "Сначала разблокируйте настройки текущим паролем."
    };
  }

  if (!currentPassword || !(await verifyPassword(currentPassword, parentalControl))) {
    return {
      ok: false,
      error: "Текущий пароль указан неверно."
    };
  }

  await chrome.storage.local.remove(STORAGE_KEYS.parentalControl);
  await setSettingsUnlocked(false);

  return {
    ok: true,
    lock: await getSettingsLockState()
  };
}

async function verifyPassword(password, parentalControl) {
  if (!password || !parentalControl.passwordHash || !parentalControl.passwordSalt) {
    return false;
  }

  const candidateHash = await derivePasswordHash(password, parentalControl.passwordSalt);
  return candidateHash === parentalControl.passwordHash;
}

function generateSaltHex() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

async function derivePasswordHash(password, saltHex) {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(String(password || "")),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: hexToBytes(saltHex),
      iterations: PASSWORD_HASH_ITERATIONS
    },
    baseKey,
    256
  );

  return bytesToHex(new Uint8Array(derivedBits));
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const normalized = String(hex || "").trim();
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return bytes;
}

async function ensureBundleLoaded(options) {
  const forceRefresh = Boolean(options?.forceRefresh);

  if (activeBundle && !forceRefresh) {
    return activeBundle;
  }

  await chrome.storage.local.remove(STORAGE_KEYS.dataBundle);

  const settings = await getSettings();
  const source = await resolveBundleSource(settings);
  const bundle = await loadBundle(source);
  setActiveBundle(bundle);

  await appendUpdateHistory({
    checkedAt: new Date().toISOString(),
    sourceLabel: bundle.metadata?.sourceLabel || "unknown",
    status: "ok",
    details: `Версия ${bundle.version}`
  });

  return activeBundle;
}

async function getSourceConfig(forceRefresh) {
  if (sourceConfigCache && !forceRefresh) {
    return sourceConfigCache;
  }

  try {
    const response = await fetch(chrome.runtime.getURL(SOURCE_CONFIG_PATH), { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    sourceConfigCache = normalizeSourceConfig(payload);
    return sourceConfigCache;
  } catch (error) {
    sourceConfigCache = normalizeSourceConfig({});
    return sourceConfigCache;
  }
}

function normalizeSourceConfig(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const repo = source.repo && typeof source.repo === "object" ? source.repo : {};

  return {
    bundleUrl: String(source.bundleUrl || "").trim(),
    sourceLabel: String(source.sourceLabel || "github-source-config"),
    configuredAt: source.configuredAt || null,
    repo: {
      owner: String(repo.owner || "").trim(),
      name: String(repo.name || "").trim(),
      branch: String(repo.branch || "main").trim() || "main",
      bundlePath: String(repo.bundlePath || "extension/data/default-bundle.json").trim() || "extension/data/default-bundle.json"
    }
  };
}

function setActiveBundle(bundle) {
  activeBundle = bundle;
  activeBundleIndex = createBundleIndex(bundle);
}

function createFilteringBundle(bundle) {
  return {
    version: bundle.version,
    updatedAt: bundle.updatedAt,
    metadata: bundle.metadata,
    dictionary: bundle.dictionary || [],
    exceptions: bundle.exceptions || []
  };
}

function createBundleIndex(bundle) {
  const domainMap = new Map();
  const hostnameMap = new Map();
  const urlContains = [];

  for (const entry of bundle.blockedSites || []) {
    if (entry.type === "domain") {
      domainMap.set(entry.value, entry);
      continue;
    }

    if (entry.type === "hostname") {
      hostnameMap.set(entry.value, entry);
      continue;
    }

    if (entry.type === "url-contains") {
      urlContains.push(entry);
    }
  }

  return { domainMap, hostnameMap, urlContains };
}

async function resolveBundleSource(settings) {
  if (settings.remoteDataUrl) {
    return {
      kind: "manual-settings",
      label: "manual-settings",
      url: settings.remoteDataUrl
    };
  }

  const sourceConfig = await getSourceConfig(false);
  if (sourceConfig.bundleUrl) {
    return {
      kind: "github-source-config",
      label: sourceConfig.sourceLabel || "github-source-config",
      url: sourceConfig.bundleUrl
    };
  }

  return {
    kind: "bundled-default",
    label: "bundled-default",
    url: ""
  };
}

async function loadBundle(source) {
  const checkedAt = new Date().toISOString();
  const localBundle = await loadBundledFallbackBundle(checkedAt);

  if (source.url) {
    try {
      const response = await fetch(source.url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Не удалось загрузить удаленные данные: HTTP ${response.status}`);
      }

      const payload = await response.json();
      const remoteBundle = normalizeBundle(payload);
      remoteBundle.metadata.checkedAt = checkedAt;
      remoteBundle.metadata.sourceLabel = source.url;
      return mergeRemoteBundle(remoteBundle, localBundle);
    } catch (error) {
      await appendUpdateHistory({
        checkedAt,
        sourceLabel: source.url,
        status: "error",
        details: error.message
      });
    }
  }

  return localBundle;
}

async function loadBundledFallbackBundle(checkedAt) {
  const localResponse = await fetch(chrome.runtime.getURL("data/default-bundle.json"), { cache: "no-store" });
  const localPayload = await localResponse.json();
  const bundle = normalizeBundle(localPayload);
  bundle.metadata.checkedAt = checkedAt;
  bundle.metadata.sourceLabel = "bundled-default";
  return bundle;
}

function mergeRemoteBundle(remoteBundle, localBundle) {
  const merged = normalizeBundle({
    ...remoteBundle,
    dictionary: (localBundle.dictionary || []).length > 0 ? localBundle.dictionary : remoteBundle.dictionary,
    exceptions: (localBundle.exceptions || []).length > 0 ? localBundle.exceptions : remoteBundle.exceptions
  });

  merged.metadata.checkedAt = remoteBundle.metadata?.checkedAt || localBundle.metadata?.checkedAt || null;
  merged.metadata.sourceLabel = remoteBundle.metadata?.sourceLabel || localBundle.metadata?.sourceLabel || "unknown";
  merged.metadata.notes = [
    remoteBundle.metadata?.notes || "",
    "Локальные словарь и исключения применены поверх удалённого списка сайтов."
  ].filter(Boolean).join(" ");

  return merged;
}

async function getUpdateHistory() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.updateHistory);
  return Array.isArray(stored[STORAGE_KEYS.updateHistory]) ? stored[STORAGE_KEYS.updateHistory] : [];
}

async function appendUpdateHistory(entry) {
  const history = await getUpdateHistory();
  const nextHistory = [entry, ...history].slice(0, 12);
  await chrome.storage.local.set({
    [STORAGE_KEYS.updateHistory]: nextHistory
  });
}

async function evaluateUrl(url, settingsParam, bundleParam) {
  const settings = settingsParam || await getSettings();
  const bundle = bundleParam || await ensureBundleLoaded({ forceRefresh: false });
  const hostname = getHostnameFromUrl(url);

  if (!settings.blockingEnabled || !hostname || isTrustedHost(hostname, settings.trustedSites)) {
    return {
      blocked: false,
      entry: null,
      hostname
    };
  }

  const entry = matchBlockedSite(url, bundle.blockedSites);
  return {
    blocked: Boolean(entry),
    entry,
    hostname
  };
}

function matchBlockedSite(url, blockedSites) {
  const normalizedUrl = String(url || "").toLowerCase();
  const hostname = normalizeHost(getHostnameFromUrl(url));

  if (activeBundleIndex.hostnameMap.has(hostname)) {
    return activeBundleIndex.hostnameMap.get(hostname);
  }

  let candidate = hostname;
  while (candidate) {
    if (activeBundleIndex.domainMap.has(candidate)) {
      return activeBundleIndex.domainMap.get(candidate);
    }

    const dotIndex = candidate.indexOf(".");
    if (dotIndex === -1) {
      break;
    }
    candidate = candidate.slice(dotIndex + 1);
  }

  for (const entry of activeBundleIndex.urlContains) {
    if (normalizedUrl.includes(entry.value)) {
      return entry;
    }
  }

  return null;
}

function buildBlockedPageUrl(originalUrl, entry) {
  const params = new URLSearchParams({
    originalUrl,
    source: entry?.source || "unknown",
    ruleType: entry?.type || "unknown",
    ruleValue: entry?.value || "",
    note: entry?.note || ""
  });

  return `${chrome.runtime.getURL("views/blocked.html")}?${params.toString()}`;
}

function isBrowserInternalUrl(url) {
  return /^(about:|chrome:|chrome-extension:|edge:|moz-extension:|view-source:|file:)/i.test(url);
}

async function reinjectContentScripts() {
  const tabs = await chrome.tabs.query({});

  await Promise.allSettled(
    tabs
      .filter((tab) => typeof tab.id === "number" && tab.url && /^https?:/i.test(tab.url) && !isBrowserInternalUrl(tab.url))
      .map((tab) =>
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["lib/shared.js", "content-script.js"]
        })
      )
  );
}
