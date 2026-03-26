const {
  DEFAULT_SETTINGS,
  deepClone,
  sanitizeStringList,
  formatDateTime,
  escapeHtml
} = globalThis.CenzControlShared;

const elements = {};
const state = {
  settings: deepClone(DEFAULT_SETTINGS),
  lock: {
    enabled: false,
    unlocked: true
  }
};

document.addEventListener("DOMContentLoaded", async () => {
  bindElements();
  bindActions();
  await loadState();
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
    "saveStatus",
    "protectedSettings",
    "lockTitle",
    "lockDescription",
    "unlockCard",
    "unlockPassword",
    "unlockButton",
    "lockButton",
    "passwordCardTitle",
    "currentPasswordField",
    "currentPassword",
    "newPasswordLabel",
    "newPassword",
    "confirmPassword",
    "savePasswordButton",
    "clearPasswordButton"
  ]) {
    elements[id] = document.getElementById(id);
  }
}

function bindActions() {
  elements.saveButton.addEventListener("click", saveOptions);
  elements.refreshButton.addEventListener("click", forceUpdate);
  elements.resetButton.addEventListener("click", () => {
    if (!canManageSettings()) {
      renderStatus("Настройки защищены родительским паролем.");
      return;
    }

    fillSettings(deepClone(DEFAULT_SETTINGS));
    renderStatus("Значения возвращены к умолчанию. Нажмите «Сохранить настройки».");
  });

  elements.unlockButton.addEventListener("click", unlockSettings);
  elements.lockButton.addEventListener("click", lockSettings);
  elements.savePasswordButton.addEventListener("click", savePassword);
  elements.clearPasswordButton.addEventListener("click", clearPassword);
  elements.unlockPassword.addEventListener("keydown", async (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      await unlockSettings();
    }
  });
}

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: "cc:getOptionsState" });
  if (!response?.ok) {
    renderStatus(response?.error || "Не удалось загрузить настройки.");
    return;
  }

  state.settings = response.settings;
  state.lock = response.lock || state.lock;
  fillSettings(response.settings);
  fillMeta(response.bundleMeta, response.updateHistory);
  renderLockState();
  renderStatus("Настройки загружены.");
}

function fillSettings(settings) {
  state.settings = deepClone(settings);
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

function renderLockState() {
  const locked = state.lock.enabled && !state.lock.unlocked;
  const passwordEnabled = Boolean(state.lock.enabled);

  elements.protectedSettings.classList.toggle("locked-block", locked);
  setProtectedControlsDisabled(locked);

  elements.unlockCard.classList.toggle("hidden", !locked);
  elements.lockButton.classList.toggle("hidden", !passwordEnabled || locked);
  elements.currentPasswordField.classList.toggle("hidden", !passwordEnabled);
  elements.clearPasswordButton.classList.toggle("hidden", !passwordEnabled);

  if (!passwordEnabled) {
    elements.lockTitle.textContent = "Настройки открыты";
    elements.lockDescription.textContent = "Можно задать пароль, чтобы ребёнок не менял настройки без разрешения.";
    elements.passwordCardTitle.textContent = "Установить пароль";
    elements.newPasswordLabel.textContent = "Новый пароль";
    return;
  }

  elements.passwordCardTitle.textContent = "Изменить пароль";
  elements.newPasswordLabel.textContent = "Новый пароль";

  if (locked) {
    elements.lockTitle.textContent = "Настройки заблокированы";
    elements.lockDescription.textContent = "Для изменения параметров сначала введите родительский пароль.";
    return;
  }

  elements.lockTitle.textContent = "Настройки разблокированы";
  elements.lockDescription.textContent = "Пароль активен. Изменения настроек снова можно закрыть одной кнопкой.";
}

function setProtectedControlsDisabled(disabled) {
  for (const element of elements.protectedSettings.querySelectorAll("input, select, textarea, button")) {
    element.disabled = disabled;
  }
}

function canManageSettings() {
  return !state.lock.enabled || state.lock.unlocked;
}

async function unlockSettings() {
  const response = await chrome.runtime.sendMessage({
    type: "cc:unlockSettings",
    password: elements.unlockPassword.value
  });

  if (!response?.ok) {
    renderStatus(response?.error || "Не удалось разблокировать настройки.");
    return;
  }

  state.lock = response.lock || state.lock;
  elements.unlockPassword.value = "";
  renderLockState();
  renderStatus("Настройки разблокированы.");
}

async function lockSettings() {
  const response = await chrome.runtime.sendMessage({ type: "cc:lockSettings" });
  state.lock = response?.lock || state.lock;
  renderLockState();
  renderStatus("Настройки снова защищены паролем.");
}

async function savePassword() {
  const newPassword = elements.newPassword.value;
  const confirmPassword = elements.confirmPassword.value;

  if (newPassword !== confirmPassword) {
    renderStatus("Подтверждение пароля не совпадает.");
    return;
  }

  const response = await chrome.runtime.sendMessage({
    type: "cc:setSettingsPassword",
    currentPassword: elements.currentPassword.value,
    newPassword
  });

  if (!response?.ok) {
    renderStatus(response?.error || "Не удалось сохранить пароль.");
    return;
  }

  state.lock = response.lock || state.lock;
  clearPasswordInputs();
  renderLockState();
  renderStatus("Пароль сохранён.");
}

async function clearPassword() {
  const response = await chrome.runtime.sendMessage({
    type: "cc:clearSettingsPassword",
    currentPassword: elements.currentPassword.value
  });

  if (!response?.ok) {
    renderStatus(response?.error || "Не удалось удалить пароль.");
    return;
  }

  state.lock = response.lock || state.lock;
  clearPasswordInputs();
  renderLockState();
  renderStatus("Пароль удалён.");
}

async function saveOptions() {
  if (!canManageSettings()) {
    renderStatus("Настройки защищены родительским паролем.");
    return;
  }

  renderStatus("Сохранение...");
  const response = await chrome.runtime.sendMessage({
    type: "cc:saveOptions",
    settings: collectSettings()
  });

  if (!response?.ok) {
    renderStatus(response?.error || "Сохранение не удалось.");
    return;
  }

  state.settings = response.settings;
  renderStatus("Настройки сохранены.");
}

async function forceUpdate() {
  renderStatus("Проверка обновлений...");
  const response = await chrome.runtime.sendMessage({ type: "cc:forceUpdate" });
  if (!response?.ok) {
    renderStatus(response?.error || "Обновление не удалось.");
    return;
  }

  const stateResponse = await chrome.runtime.sendMessage({ type: "cc:getOptionsState" });
  if (stateResponse?.ok) {
    state.lock = stateResponse.lock || state.lock;
    fillMeta(stateResponse.bundleMeta, stateResponse.updateHistory);
    renderLockState();
  }

  renderStatus("Данные обновлены.");
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

function clearPasswordInputs() {
  elements.unlockPassword.value = "";
  elements.currentPassword.value = "";
  elements.newPassword.value = "";
  elements.confirmPassword.value = "";
}

function renderStatus(message) {
  elements.saveStatus.textContent = message;
}
