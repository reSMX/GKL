const { formatDateTime, getHostnameFromUrl } = globalThis.CenzControlShared;

document.addEventListener("DOMContentLoaded", async () => {
  const elements = {
    siteHost: document.getElementById("siteHost"),
    filteringEnabled: document.getElementById("filteringEnabled"),
    blockingEnabled: document.getElementById("blockingEnabled"),
    replacedCount: document.getElementById("replacedCount"),
    scannedNodes: document.getElementById("scannedNodes"),
    decisionText: document.getElementById("decisionText"),
    bundleUpdatedAt: document.getElementById("bundleUpdatedAt"),
    bundleSource: document.getElementById("bundleSource"),
    refreshButton: document.getElementById("refreshButton"),
    optionsButton: document.getElementById("optionsButton")
  };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const currentUrl = tab?.url || "";
  const blockedPageContext = parseBlockedPageContext(currentUrl);
  const inspectedUrl = blockedPageContext?.originalUrl || currentUrl;
  const host = getHostnameFromUrl(inspectedUrl) || "локальная или внутренняя страница";
  elements.siteHost.textContent = host;

  const response = await chrome.runtime.sendMessage({
    type: "cc:getPopupState",
    tabId: tab?.id,
    url: inspectedUrl,
    tabUrl: currentUrl
  });

  if (!response?.ok) {
    elements.decisionText.textContent = response?.error || "Не удалось получить состояние расширения.";
    return;
  }

  renderState(response, elements);
  bindQuickToggles(response.settings, elements);
});

function renderState(response, elements) {
  elements.filteringEnabled.checked = Boolean(response.settings.filteringEnabled);
  elements.blockingEnabled.checked = Boolean(response.settings.blockingEnabled);
  elements.replacedCount.textContent = String(response.stats?.replacedCount || 0);
  elements.scannedNodes.textContent = String(response.stats?.scannedNodes || 0);
  elements.bundleUpdatedAt.textContent = formatDateTime(response.bundleMeta.updatedAt);
  elements.bundleSource.textContent = `Источник: ${response.bundleMeta.sourceLabel}`;

  if (response.decision?.blocked) {
    elements.decisionText.textContent = response.isBlockedPage
      ? `Текущий сайт заблокирован по правилу ${response.decision.entry?.value}. Доступ к странице уже ограничен.`
      : `Сайт совпадает с правилом ${response.decision.entry?.value}. При следующем переходе он будет перенаправлен на страницу блокировки.`;
    return;
  }

  elements.decisionText.textContent = "Страница разрешена. Фильтрация выполняется по текущим настройкам.";
}

function bindQuickToggles(settings, elements) {
  elements.filteringEnabled.addEventListener("change", async () => {
    settings.filteringEnabled = elements.filteringEnabled.checked;
    await chrome.runtime.sendMessage({
      type: "cc:saveOptions",
      settings
    });
  });

  elements.blockingEnabled.addEventListener("change", async () => {
    settings.blockingEnabled = elements.blockingEnabled.checked;
    await chrome.runtime.sendMessage({
      type: "cc:saveOptions",
      settings
    });
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
}

function parseBlockedPageContext(url) {
  try {
    const blockedPageUrl = chrome.runtime.getURL("views/blocked.html");
    const parsedUrl = new URL(String(url || ""));
    if (parsedUrl.href === blockedPageUrl || parsedUrl.href.startsWith(`${blockedPageUrl}?`)) {
      return {
        originalUrl: parsedUrl.searchParams.get("originalUrl") || "",
        ruleType: parsedUrl.searchParams.get("ruleType") || "",
        ruleValue: parsedUrl.searchParams.get("ruleValue") || "",
        source: parsedUrl.searchParams.get("source") || "",
        note: parsedUrl.searchParams.get("note") || ""
      };
    }
  } catch (error) {
    return null;
  }

  return null;
}
