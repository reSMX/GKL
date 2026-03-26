const { formatDateTime, getHostnameFromUrl } = globalThis.CenzControlShared;

const elements = {};
const state = {
  tab: null,
  settings: null,
  lock: {
    enabled: false,
    unlocked: true
  }
};

document.addEventListener("DOMContentLoaded", async () => {
  bindElements();
  bindActions();
  await loadPopupState();
});

function bindElements() {
  for (const id of [
    "siteHost",
    "filteringEnabled",
    "blockingEnabled",
    "replacedCount",
    "scannedNodes",
    "decisionText",
    "bundleUpdatedAt",
    "bundleSource",
    "refreshButton",
    "optionsButton",
    "lockCard",
    "lockStatus",
    "lockHint",
    "unlockField",
    "unlockPassword",
    "unlockButton",
    "lockButton"
  ]) {
    elements[id] = document.getElementById(id);
  }
}

function bindActions() {
  elements.filteringEnabled.addEventListener("change", async () => {
    if (!canEditSettings()) {
      elements.filteringEnabled.checked = Boolean(state.settings?.filteringEnabled);
      return;
    }

    state.settings.filteringEnabled = elements.filteringEnabled.checked;
    await saveQuickSettings();
  });

  elements.blockingEnabled.addEventListener("change", async () => {
    if (!canEditSettings()) {
      elements.blockingEnabled.checked = Boolean(state.settings?.blockingEnabled);
      return;
    }

    state.settings.blockingEnabled = elements.blockingEnabled.checked;
    await saveQuickSettings();
  });

  elements.refreshButton.addEventListener("click", async () => {
    elements.refreshButton.disabled = true;
    elements.refreshButton.textContent = "Обновление...";
    await chrome.runtime.sendMessage({ type: "cc:forceUpdate" });
    window.close();
  });

  elements.optionsButton.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  elements.unlockButton.addEventListener("click", async () => {
    const password = elements.unlockPassword.value;
    const response = await chrome.runtime.sendMessage({
      type: "cc:unlockSettings",
      password
    });

    if (!response?.ok) {
      elements.lockHint.textContent = response?.error || "Не удалось разблокировать настройки.";
      return;
    }

    elements.unlockPassword.value = "";
    state.lock = response.lock || state.lock;
    applyLockState();
    elements.lockHint.textContent = "Настройки разблокированы до ручной блокировки или перезапуска браузера.";
  });

  elements.lockButton.addEventListener("click", async () => {
    const response = await chrome.runtime.sendMessage({ type: "cc:lockSettings" });
    state.lock = response?.lock || state.lock;
    applyLockState();
    elements.lockHint.textContent = "Настройки снова защищены паролем.";
  });

  elements.unlockPassword.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      await elements.unlockButton.click();
    }
  });
}

async function loadPopupState() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tab = tab || null;

  const url = tab?.url || "";
  const host = getHostnameFromUrl(url) || "локальная или внутренняя страница";
  elements.siteHost.textContent = host;

  const response = await chrome.runtime.sendMessage({
    type: "cc:getPopupState",
    tabId: tab?.id,
    url
  });

  if (!response?.ok) {
    elements.decisionText.textContent = response?.error || "Не удалось получить состояние расширения.";
    return;
  }

  state.settings = response.settings;
  state.lock = response.lock || state.lock;

  renderState(response);
  applyLockState();
}

function renderState(response) {
  elements.filteringEnabled.checked = Boolean(response.settings.filteringEnabled);
  elements.blockingEnabled.checked = Boolean(response.settings.blockingEnabled);
  elements.replacedCount.textContent = String(response.stats?.replacedCount || 0);
  elements.scannedNodes.textContent = String(response.stats?.scannedNodes || 0);
  elements.bundleUpdatedAt.textContent = formatDateTime(response.bundleMeta.updatedAt);
  elements.bundleSource.textContent = `Источник: ${response.bundleMeta.sourceLabel}`;

  if (response.decision?.blocked) {
    elements.decisionText.textContent = `Сайт совпадает с правилом ${response.decision.entry?.value}. При следующем переходе он будет перенаправлен на страницу блокировки.`;
    return;
  }

  elements.decisionText.textContent = "Страница разрешена. Фильтрация выполняется по текущим настройкам.";
}

function applyLockState() {
  const locked = !canEditSettings();

  elements.filteringEnabled.disabled = locked;
  elements.blockingEnabled.disabled = locked;

  if (!state.lock.enabled) {
    elements.lockCard.classList.add("hidden");
    return;
  }

  elements.lockCard.classList.remove("hidden");
  elements.unlockField.classList.toggle("hidden", !locked);
  elements.unlockButton.classList.toggle("hidden", !locked);
  elements.lockButton.classList.toggle("hidden", locked);
  elements.lockStatus.textContent = locked
    ? "Настройки защищены паролем"
    : "Настройки разблокированы";

  if (locked) {
    elements.lockHint.textContent = "Для изменения переключателей введите пароль.";
    return;
  }

  elements.lockHint.textContent = "Переключатели доступны. При желании можно снова заблокировать настройки.";
}

function canEditSettings() {
  return !state.lock.enabled || state.lock.unlocked;
}

async function saveQuickSettings() {
  const response = await chrome.runtime.sendMessage({
    type: "cc:saveOptions",
    settings: state.settings
  });

  if (!response?.ok) {
    elements.decisionText.textContent = response?.error || "Не удалось сохранить настройки.";
    return;
  }

  state.settings = response.settings;
}
