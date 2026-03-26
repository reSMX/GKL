(() => {
  if (globalThis.__cenzControlContentScriptLoaded) {
    return;
  }
  globalThis.__cenzControlContentScriptLoaded = true;

  const {
    normalizeToken,
    shouldUseRule,
    shouldSkipTextNode
  } = globalThis.CenzControlShared;

  const state = {
    settings: null,
    bundle: null,
    compiledRules: [],
    exceptionTokens: new Set(),
    isTrusted: false,
    replacedCount: 0,
    scannedNodes: 0,
    ruleHits: {},
    observer: null,
    applying: false,
    reportTimer: null,
    extensionAlive: true
  };

  window.addEventListener("error", (event) => {
    if (isExtensionContextInvalidatedError(event.error || event.message)) {
      event.preventDefault();
      deactivateExtensionContext();
    }
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (isExtensionContextInvalidatedError(event.reason)) {
      event.preventDefault();
      deactivateExtensionContext();
    }
  });

  if (!/^https?:/i.test(location.protocol)) {
    return;
  }

  init().catch((error) => {
    if (isExtensionContextInvalidatedError(error)) {
      deactivateExtensionContext();
    }
  });

  async function init() {
    const response = await safeSendMessage({
      type: "cc:getPageContext",
      url: location.href
    });

    if (!response?.ok) {
      return;
    }

    state.settings = response.settings;
    state.bundle = response.bundle;
    state.isTrusted = response.isTrusted;
    state.compiledRules = compileRules();
    state.exceptionTokens = compileExceptions();

    if (!state.settings.filteringEnabled || state.isTrusted) {
      scheduleReport();
      return;
    }

    processRoot(document.body);
    observeMutations();
    scheduleReport();
  }

  function observeMutations() {
    if (!document.body) {
      return;
    }

    state.observer = new MutationObserver((mutations) => {
      if (state.applying) {
        return;
      }

      for (const mutation of mutations) {
        if (mutation.type === "characterData" && mutation.target.nodeType === Node.TEXT_NODE) {
          processTextNode(mutation.target);
          continue;
        }

        for (const addedNode of mutation.addedNodes) {
          processRoot(addedNode);
        }
      }

      scheduleReport();
    });

    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function processRoot(root) {
    if (!state.extensionAlive) {
      return;
    }

    if (!root) {
      return;
    }

    if (root.nodeType === Node.TEXT_NODE) {
      processTextNode(root);
      return;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    while (walker.nextNode()) {
      textNodes.push(walker.currentNode);
    }

    for (const node of textNodes) {
      processTextNode(node);
    }
  }

  function processTextNode(node) {
    if (!state.extensionAlive) {
      return;
    }

    if (shouldSkipTextNode(node)) {
      return;
    }

    const originalText = node.textContent || "";
    if (!originalText.trim()) {
      return;
    }

    state.scannedNodes += 1;
    let transformed = null;
    try {
      transformed = transformText(originalText);
    } catch (error) {
      return;
    }
    if (!transformed || transformed.text === originalText) {
      return;
    }

    state.applying = true;
    node.textContent = transformed.text;
    state.applying = false;

    state.replacedCount += transformed.matchCount;
    for (const [ruleId, count] of Object.entries(transformed.ruleHits)) {
      state.ruleHits[ruleId] = (state.ruleHits[ruleId] || 0) + count;
    }
  }

  function transformText(text) {
    const matches = [];

    for (const token of iterateWordTokens(text)) {
      const normalizedToken = normalizeToken(token.raw);
      if (!normalizedToken || normalizedToken.length < 3) {
        continue;
      }

      if (state.exceptionTokens.has(normalizedToken)) {
        continue;
      }

      const rule = findMatchingRule(normalizedToken);
      if (!rule) {
        continue;
      }

      matches.push({
        ruleId: rule.id,
        rawStart: token.start,
        rawEnd: token.end,
        replacement: getReplacement(rule, token.raw)
      });
    }

    if (matches.length === 0) {
      return null;
    }

    let output = text;
    const ruleHits = {};
    for (const match of [...matches].sort((left, right) => right.rawStart - left.rawStart)) {
      output = `${output.slice(0, match.rawStart)}${match.replacement}${output.slice(match.rawEnd)}`;
      ruleHits[match.ruleId] = (ruleHits[match.ruleId] || 0) + 1;
    }

    return {
      text: output,
      matchCount: matches.length,
      ruleHits
    };
  }

  function compileExceptions() {
    const customExceptions = state.settings.customExceptions || [];
    return new Set(
      [...(state.bundle.exceptions || []), ...customExceptions]
        .map((item) => normalizeToken(item))
        .filter(Boolean)
    );
  }

  function compileRules() {
    const compiled = [];
    for (const rule of state.bundle.dictionary || []) {
      if (!shouldUseRule(rule.severity, state.settings.strictness)) {
        continue;
      }

      compiled.push({
        id: rule.id,
        replacement: rule.replacement,
        tokenRegexes: (rule.patterns || []).flatMap((pattern) => {
          try {
            return [new RegExp(`^(?:${pattern})$`, "iu")];
          } catch (error) {
            return [];
          }
        })
      });
    }

    return compiled;
  }

  function findMatchingRule(normalizedToken) {
    for (const rule of state.compiledRules) {
      if (rule.tokenRegexes.some((regex) => regex.test(normalizedToken))) {
        return rule;
      }
    }

    return null;
  }

  function iterateWordTokens(text) {
    const tokens = [];
    const input = String(text || "");
    const regex = /[\p{L}\p{N}@]+/gu;

    for (const match of input.matchAll(regex)) {
      const raw = match[0];
      if (!raw) {
        continue;
      }

      const start = Number(match.index);
      const end = start + raw.length;
      tokens.push({ raw, start, end });
    }

    return tokens;
  }

  function getReplacement(rule, originalSlice) {
    if (state.settings.replacementMode === "soft") {
      return rule.replacement || state.settings.replacementWord;
    }

    if (state.settings.replacementMode === "placeholder") {
      return state.settings.replacementWord;
    }

    const characters = Array.from(originalSlice);
    const masked = characters.map((character) => (/\p{L}|\p{N}/u.test(character) ? "*" : character));
    return masked.join("");
  }

  function scheduleReport() {
    if (!state.extensionAlive) {
      return;
    }

    window.clearTimeout(state.reportTimer);
    state.reportTimer = window.setTimeout(() => {
      void safeSendMessage({
        type: "cc:reportStats",
        url: location.href,
        stats: {
          replacedCount: state.replacedCount,
          scannedNodes: state.scannedNodes,
          ruleHits: state.ruleHits
        }
      });
    }, 250);
  }

  async function safeSendMessage(payload) {
    if (!state.extensionAlive) {
      return null;
    }

    try {
      if (!hasRuntimeAccess()) {
        deactivateExtensionContext();
        return null;
      }

      return await chrome.runtime.sendMessage(payload);
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        deactivateExtensionContext();
        return null;
      }

      return null;
    }
  }

  function deactivateExtensionContext() {
    if (!state.extensionAlive) {
      return;
    }

    state.extensionAlive = false;
    window.clearTimeout(state.reportTimer);
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  function hasRuntimeAccess() {
    try {
      return Boolean(chrome?.runtime?.id);
    } catch (error) {
      return false;
    }
  }

  function isExtensionContextInvalidatedError(error) {
    return String(error?.message || error || "").includes("Extension context invalidated");
  }
})();
