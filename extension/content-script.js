(() => {
  const {
    normalizeTextWithMap,
    normalizeToken,
    shouldUseRule,
    shouldSkipTextNode
  } = globalThis.CenzControlShared;

  const state = {
    settings: null,
    bundle: null,
    isTrusted: false,
    replacedCount: 0,
    scannedNodes: 0,
    ruleHits: {},
    observer: null,
    applying: false,
    reportTimer: null
  };

  if (!/^https?:/i.test(location.protocol)) {
    return;
  }

  init().catch(() => {
    /* ignore page-side failures */
  });

  async function init() {
    const response = await chrome.runtime.sendMessage({
      type: "cc:getPageContext",
      url: location.href
    });

    if (!response?.ok) {
      return;
    }

    state.settings = response.settings;
    state.bundle = response.bundle;
    state.isTrusted = response.isTrusted;

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
    if (shouldSkipTextNode(node)) {
      return;
    }

    const originalText = node.textContent || "";
    if (!originalText.trim()) {
      return;
    }

    state.scannedNodes += 1;
    const transformed = transformText(originalText);
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
    const scan = normalizeTextWithMap(text);
    if (!scan.normalized || scan.normalized.length < 3) {
      return null;
    }

    const exceptionRanges = collectExceptionRanges(scan.normalized);
    const matches = [];

    for (const rule of state.bundle.dictionary || []) {
      if (!shouldUseRule(rule.severity, state.settings.strictness)) {
        continue;
      }

      for (const pattern of rule.patterns) {
        const regex = new RegExp(pattern, "giu");
        for (const match of scan.normalized.matchAll(regex)) {
          const matchedText = match[0];
          if (!matchedText) {
            continue;
          }

          const normStart = Number(match.index);
          const normEnd = normStart + matchedText.length;
          if (isInsideException(normStart, normEnd, exceptionRanges)) {
            continue;
          }

          const rawStart = scan.positions[normStart];
          const rawEnd = scan.positions[normEnd - 1] + 1;
          if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd)) {
            continue;
          }

          const rawSlice = text.slice(rawStart, rawEnd);
          if (!isWordLikeMatch(rawSlice)) {
            continue;
          }

          matches.push({
            ruleId: rule.id,
            rawStart,
            rawEnd,
            replacement: getReplacement(rule, rawSlice)
          });
        }
      }
    }

    const finalMatches = compactMatches(matches);
    if (finalMatches.length === 0) {
      return null;
    }

    let output = text;
    const ruleHits = {};
    for (const match of [...finalMatches].sort((left, right) => right.rawStart - left.rawStart)) {
      output = `${output.slice(0, match.rawStart)}${match.replacement}${output.slice(match.rawEnd)}`;
      ruleHits[match.ruleId] = (ruleHits[match.ruleId] || 0) + 1;
    }

    return {
      text: output,
      matchCount: finalMatches.length,
      ruleHits
    };
  }

  function collectExceptionRanges(normalizedText) {
    const ranges = [];
    const customExceptions = state.settings.customExceptions || [];
    const combined = [...(state.bundle.exceptions || []), ...customExceptions].map((item) => normalizeToken(item)).filter(Boolean);

    for (const exception of combined) {
      const escaped = exception.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escaped, "giu");
      for (const match of normalizedText.matchAll(regex)) {
        if (!match[0]) {
          continue;
        }
        ranges.push({
          start: Number(match.index),
          end: Number(match.index) + match[0].length
        });
      }
    }

    return ranges;
  }

  function isInsideException(start, end, ranges) {
    return ranges.some((range) => start >= range.start && end <= range.end);
  }

  function compactMatches(matches) {
    const sorted = [...matches].sort((left, right) => {
      const leftLength = left.rawEnd - left.rawStart;
      const rightLength = right.rawEnd - right.rawStart;
      if (rightLength !== leftLength) {
        return rightLength - leftLength;
      }
      return left.rawStart - right.rawStart;
    });

    const selected = [];
    for (const candidate of sorted) {
      const overlaps = selected.some((item) => !(candidate.rawEnd <= item.rawStart || candidate.rawStart >= item.rawEnd));
      if (!overlaps) {
        selected.push(candidate);
      }
    }

    return selected.sort((left, right) => left.rawStart - right.rawStart);
  }

  function isWordLikeMatch(rawSlice) {
    const chunks = String(rawSlice || "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);

    if (chunks.length <= 1) {
      return true;
    }

    return chunks.every((chunk) => chunk.length <= 2);
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
    window.clearTimeout(state.reportTimer);
    state.reportTimer = window.setTimeout(() => {
      void chrome.runtime.sendMessage({
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
})();
