const {
  DEFAULT_SETTINGS,
  deepClone,
  sanitizeStringList,
  formatDateTime,
  escapeHtml
} = globalThis.CenzControlShared;

const elements = {};

document.addEventListener("DOMContentLoaded", async () => {
  bindElements();
  await loadState();
  bindActions();
});

function bindElements() {
  for (const id of [
    "filteringEnabled",
    "blockingEnabled",
    "strictness",
    "replacementMode",
    "replacementWord",
    "remoteDataUrl",
    "autoUpdateHours",
    "trustedSites",
    "customExceptions",
    "bundleVersion",
    "bundleUpdatedAt",
    "bundleCheckedAt",
    "bundleSource",
    "blockedSitesSize",
    "dictionarySize",
    "exceptionsSize",
    "updateHistory",
    "saveButton",
    "refreshButton",
    "resetButton",
    "saveStatus"
  ]) {
    elements[id] = document.getElementById(id);
  }
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: "cc:getOptionsState" });
  if (!response?.ok) {
    elements.saveStatus.textContent = response?.error || "Не удалось загрузить настройки.";
    return;
  }

  fillSettings(response.settings);
  fillMeta(response.bundleMeta, response.updateHistory);
  elements.saveStatus.textContent = "Настройки загружены.";
}

function fillSettings(settings) {
  elements.filteringEnabled.checked = Boolean(settings.filteringEnabled);
  elements.blockingEnabled.checked = Boolean(settings.blockingEnabled);
  elements.strictness.value = settings.strictness;
  elements.replacementMode.value = settings.replacementMode;
  elements.replacementWord.value = settings.replacementWord;
  elements.remoteDataUrl.value = settings.remoteDataUrl;
  elements.autoUpdateHours.value = String(settings.autoUpdateHours);
  elements.trustedSites.value = (settings.trustedSites || []).join("\n");
  elements.customExceptions.value = (settings.customExceptions || []).join("\n");
}

function fillMeta(meta, history) {
  elements.bundleVersion.textContent = meta.version;
  elements.bundleUpdatedAt.textContent = formatDateTime(meta.updatedAt);
  elements.bundleCheckedAt.textContent = formatDateTime(meta.checkedAt);
  elements.bundleSource.textContent = meta.sourceLabel;
  elements.blockedSitesSize.textContent = String(meta.blockedSitesSize);
  elements.dictionarySize.textContent = String(meta.dictionarySize);
  elements.exceptionsSize.textContent = String(meta.exceptionsSize);
  renderHistory(history || []);
}

function renderHistory(history) {
  if (history.length === 0) {
    elements.updateHistory.innerHTML = '<p class="muted">История обновлений пока пуста.</p>';
    return;
  }

  elements.updateHistory.innerHTML = history
    .map((entry) => `
      <article class="history-item">
        <strong>${escapeHtml(entry.status === "ok" ? "Успешно" : "Ошибка")}</strong>
        <p>${escapeHtml(entry.sourceLabel || "unknown")}</p>
        <p class="muted">${escapeHtml(formatDateTime(entry.checkedAt))}</p>
        <p class="muted">${escapeHtml(entry.details || "")}</p>
      </article>
    `)
    .join("");
}

function bindActions() {
  elements.saveButton.addEventListener("click", saveOptions);
  elements.refreshButton.addEventListener("click", forceUpdate);
  elements.resetButton.addEventListener("click", () => {
    fillSettings(deepClone(DEFAULT_SETTINGS));
    elements.saveStatus.textContent = "Значения возвращены к умолчанию. Нажмите «Сохранить настройки».";
  });
}

async function saveOptions() {
  elements.saveStatus.textContent = "Сохранение...";
  const response = await chrome.runtime.sendMessage({
    type: "cc:saveOptions",
    settings: collectSettings()
  });

  if (!response?.ok) {
    elements.saveStatus.textContent = response?.error || "Сохранение не удалось.";
    return;
  }

  elements.saveStatus.textContent = "Настройки сохранены.";
}

async function forceUpdate() {
  elements.saveStatus.textContent = "Проверка обновлений...";
  const response = await chrome.runtime.sendMessage({ type: "cc:forceUpdate" });
  if (!response?.ok) {
    elements.saveStatus.textContent = response?.error || "Обновление не удалось.";
    return;
  }

  const stateResponse = await chrome.runtime.sendMessage({ type: "cc:getOptionsState" });
  if (stateResponse?.ok) {
    fillMeta(stateResponse.bundleMeta, stateResponse.updateHistory);
  }
  elements.saveStatus.textContent = "Данные обновлены.";
}

function collectSettings() {
  return {
    filteringEnabled: elements.filteringEnabled.checked,
    blockingEnabled: elements.blockingEnabled.checked,
    strictness: elements.strictness.value,
    replacementMode: elements.replacementMode.value,
    replacementWord: elements.replacementWord.value.trim(),
    remoteDataUrl: elements.remoteDataUrl.value.trim(),
    autoUpdateHours: Number(elements.autoUpdateHours.value || DEFAULT_SETTINGS.autoUpdateHours),
    trustedSites: sanitizeStringList(elements.trustedSites.value, "host"),
    customExceptions: sanitizeStringList(elements.customExceptions.value, "token")
  };
}
