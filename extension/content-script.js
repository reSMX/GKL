(() => {
  try {
    if (globalThis.__cenzControlContentScriptController?.deactivate) {
      globalThis.__cenzControlContentScriptController.deactivate();
    }
  } catch (error) {
    if (String(error?.message || error || "").includes("Extension context invalidated")) {
      delete globalThis.__cenzControlContentScriptController;
    } else {
      throw error;
    }
  }

  const {
    normalizeToken,
    shouldUseRule,
    shouldSkipTextNode
  } = globalThis.CenzControlShared;
  const TOKEN_SCAN_RE = /[\p{L}\p{N}@]+/gu;
  const SEVERITY_SCORE = {
    low: 1,
    medium: 2,
    high: 3
  };

  const state = {
    settings: null,
    bundle: null,
    compiledRules: {
      exactRules: new Map(),
      regexRules: []
    },
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
  const abortController = new AbortController();
  globalThis.__cenzControlContentScriptController = {
    deactivate: () => deactivateExtensionContext()
  };

  window.addEventListener("error", (event) => {
    if (isExtensionContextInvalidatedError(event.error || event.message)) {
      event.preventDefault();
      deactivateExtensionContext();
    }
  }, { signal: abortController.signal });

  window.addEventListener("unhandledrejection", (event) => {
    if (isExtensionContextInvalidatedError(event.reason)) {
      event.preventDefault();
      deactivateExtensionContext();
    }
  }, { signal: abortController.signal });

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
    try {
      state.exceptionTokens = collectExceptionTokens();
      state.compiledRules = compileRules();
    } catch (error) {
      if (isExtensionContextInvalidatedError(error)) {
        deactivateExtensionContext();
        return;
      }
      throw error;
    }

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
      if (!hasRuntimeAccess()) {
        deactivateExtensionContext();
        return;
      }

      if (state.applying) {
        return;
      }

      try {
        for (const mutation of mutations) {
          if (mutation.type === "characterData" && mutation.target.nodeType === Node.TEXT_NODE) {
            processTextNode(mutation.target);
            continue;
          }

          for (const addedNode of mutation.addedNodes) {
            processRoot(addedNode);
          }
        }
      } catch (error) {
        if (isExtensionContextInvalidatedError(error)) {
          deactivateExtensionContext();
          return;
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

    if (!hasRuntimeAccess()) {
      deactivateExtensionContext();
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

    if (!hasRuntimeAccess()) {
      deactivateExtensionContext();
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
      if (isExtensionContextInvalidatedError(error)) {
        deactivateExtensionContext();
      }
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
    if (!state.extensionAlive || !hasRuntimeAccess()) {
      deactivateExtensionContext();
      return null;
    }

    const matches = collectTokenMatches(text);
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

  function collectExceptionTokens() {
    if (!state.extensionAlive || !hasRuntimeAccess()) {
      deactivateExtensionContext();
      return new Set();
    }

    const customExceptions = state.settings.customExceptions || [];
    return new Set(
      [...(state.bundle.exceptions || []), ...customExceptions]
        .map((item) => canonicalizeToken(item))
        .filter(Boolean)
    );
  }

  function compileRules() {
    if (!state.extensionAlive || !hasRuntimeAccess()) {
      deactivateExtensionContext();
      return {
        exactRules: new Map(),
        regexRules: []
      };
    }

    const exactRules = new Map();
    const regexRules = [];

    for (const [index, rule] of (state.bundle.dictionary || []).entries()) {
      if (!shouldUseRule(rule.severity, state.settings.strictness)) {
        continue;
      }

      const descriptor = {
        id: rule.id,
        severity: rule.severity,
        replacement: rule.replacement,
        priority: index
      };
      const exactTerms = (rule.terms || [])
        .map((term) => canonicalizeToken(term))
        .filter(Boolean);

      for (const term of exactTerms) {
        const current = exactRules.get(term);
        if (!current || isRuleHigherPriority(descriptor, current)) {
          exactRules.set(term, descriptor);
        }
      }

      if (exactTerms.length === 0) {
        const regexes = (rule.patterns || []).flatMap((pattern) => {
          try {
            return [new RegExp(`^(?:${pattern})$`, "iu")];
          } catch (error) {
            return [];
          }
        });

        if (regexes.length > 0) {
          regexRules.push({
            ...descriptor,
            regexes
          });
        }
      }
    }

    return {
      exactRules,
      regexRules
    };
  }

  function collectTokenMatches(text) {
    if (!state.extensionAlive || !hasRuntimeAccess()) {
      deactivateExtensionContext();
      return [];
    }

    const matches = [];
    for (const tokenMatch of String(text || "").matchAll(new RegExp(TOKEN_SCAN_RE))) {
      const rawToken = tokenMatch[0];
      if (!rawToken) {
        continue;
      }

      const rawStart = Number(tokenMatch.index);
      const rawEnd = rawStart + rawToken.length;
      const canonicalToken = canonicalizeToken(rawToken);
      if (!canonicalToken) {
        continue;
      }

      if (state.exceptionTokens.has(canonicalToken)) {
        continue;
      }

      const rule = findRuleForToken(canonicalToken);
      if (!rule) {
        continue;
      }

      matches.push({
        ruleId: rule.id,
        rawStart,
        rawEnd,
        replacement: getReplacement(rule, rawToken)
      });
    }

    return matches;
  }

  function findRuleForToken(token) {
    if (state.compiledRules.exactRules.has(token)) {
      return state.compiledRules.exactRules.get(token);
    }

    for (const rule of state.compiledRules.regexRules) {
      for (const regex of rule.regexes) {
        if (regex.test(token)) {
          return rule;
        }
      }
    }

    return null;
  }

  function isRuleHigherPriority(candidate, current) {
    const candidateSeverity = SEVERITY_SCORE[candidate.severity] || SEVERITY_SCORE.medium;
    const currentSeverity = SEVERITY_SCORE[current.severity] || SEVERITY_SCORE.medium;
    if (candidateSeverity !== currentSeverity) {
      return candidateSeverity > currentSeverity;
    }

    return candidate.priority < current.priority;
  }

  function canonicalizeToken(value) {
    return normalizeToken(value).replaceAll("ё", "е");
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
      if (!hasRuntimeAccess()) {
        deactivateExtensionContext();
        return;
      }

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
    abortController.abort();
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (globalThis.__cenzControlContentScriptController?.deactivate === deactivateExtensionContext) {
      delete globalThis.__cenzControlContentScriptController;
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
