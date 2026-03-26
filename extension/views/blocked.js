document.addEventListener("DOMContentLoaded", () => {
  const params = new URLSearchParams(window.location.search);
  document.getElementById("originalUrl").textContent = params.get("originalUrl") || "-";
  document.getElementById("ruleType").textContent = params.get("ruleType") || "-";
  document.getElementById("ruleValue").textContent = params.get("ruleValue") || "-";
  document.getElementById("source").textContent = params.get("source") || "-";
  document.getElementById("note").textContent = params.get("note") || "Комментарий к записи отсутствует.";

  document.getElementById("backButton").addEventListener("click", () => {
    history.back();
  });

  document.getElementById("optionsButton").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
});
