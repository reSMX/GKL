(function initSharedLibrary(global) {
  const STORAGE_KEYS = {
    settings: "cc:settings",
    dataBundle: "cc:dataBundle",
    updateHistory: "cc:updateHistory",
    pageStats: "cc:pageStats"
  };

  const DEFAULT_SETTINGS = {
    filteringEnabled: true,
    blockingEnabled: true,
    strictness: "high",
    replacementMode: "mask",
    replacementWord: "[скрыто]",
    trustedSites: [],
    customExceptions: [],
    remoteDataUrl: "",
    autoUpdateHours: 168
  };

  const STRICTNESS_RANK = {
    low: 1,
    medium: 2,
    high: 3
  };

  const SEVERITY_RANK = {
    low: 1,
    medium: 2,
    high: 3
  };

  const TOKEN_CHARACTER_RE = /[a-zа-яё]/iu;

  const CONFUSABLE_MAP = {
    "@": "а",
    "0": "о",
    "1": "и",
    "3": "з",
    "4": "ч",
    "6": "б",
    "8": "в",
    "a": "а",
    "c": "с",
    "e": "е",
    "h": "н",
    "k": "к",
    "m": "м",
    "o": "о",
    "p": "р",
    "t": "т",
    "x": "х",
    "y": "у"
  };

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function uniqueStrings(values) {
    return [...new Set((values || []).filter(Boolean))];
  }

  function normalizeHost(value) {
    const input = String(value || "").trim().toLowerCase();
    if (!input) {
      return "";
    }

    try {
      const url = input.includes("://") ? new URL(input) : new URL(`https://${input}`);
      return url.hostname.toLowerCase();
    } catch (error) {
      return input.replace(/^www\./, "").replace(/\/.*$/, "");
    }
  }

  function isLetterLike(character) {
    return /\p{L}|\p{N}/u.test(character) || Object.prototype.hasOwnProperty.call(CONFUSABLE_MAP, character.toLowerCase());
  }

  function normalizeCharacter(character) {
    const lower = character.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(CONFUSABLE_MAP, lower)) {
      return CONFUSABLE_MAP[lower];
    }

    if (lower === "ё") {
      return "е";
    }

    return lower;
  }

  function normalizeToken(value) {
    return String(value || "")
      .split("")
      .map((character) => normalizeCharacter(character))
      .filter((character) => TOKEN_CHARACTER_RE.test(character))
      .join("");
  }

  function normalizeTextWithMap(text) {
    const normalizedCharacters = [];
    const positions = [];

    Array.from(String(text || "")).forEach((character, index) => {
      if (!isLetterLike(character)) {
        return;
      }

      const normalized = normalizeCharacter(character);
      if (!TOKEN_CHARACTER_RE.test(normalized)) {
        return;
      }

      normalizedCharacters.push(normalized);
      positions.push(index);
    });

    return {
      normalized: normalizedCharacters.join(""),
      positions
    };
  }

  function getHostnameFromUrl(urlString) {
    try {
      return new URL(urlString).hostname.toLowerCase();
    } catch (error) {
      return "";
    }
  }

  function shouldUseRule(ruleSeverity, strictness) {
    const required = SEVERITY_RANK[ruleSeverity] || SEVERITY_RANK.medium;
    const active = STRICTNESS_RANK[strictness] || STRICTNESS_RANK.medium;
    return active >= required;
  }

  function sanitizeStringList(values, mode) {
    const list = Array.isArray(values)
      ? values
      : String(values || "")
          .split(/\r?\n|,/)
          .map((item) => item.trim())
          .filter(Boolean);

    const normalized = list
      .map((value) => {
        if (mode === "host") {
          return normalizeHost(value);
        }
        if (mode === "token") {
          return String(value || "").trim().toLowerCase();
        }
        return String(value || "").trim();
      })
      .filter(Boolean);

    return uniqueStrings(normalized);
  }

  function formatDateTime(value) {
    if (!value) {
      return "нет данных";
    }

    try {
      return new Date(value).toLocaleString("ru-RU");
    } catch (error) {
      return String(value);
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function createDefaultBundle() {
    return {
      version: "local-fallback",
      updatedAt: new Date(0).toISOString(),
      metadata: {
        sourceLabel: "bundled-default",
        checkedAt: null
      },
      blockedSites: [],
      dictionary: [],
      exceptions: []
    };
  }

  function normalizeBundle(bundle) {
    const input = bundle && typeof bundle === "object" ? bundle : {};

    return {
      version: String(input.version || "local-fallback"),
      updatedAt: input.updatedAt || new Date().toISOString(),
      metadata: {
        sourceLabel: String(input.metadata?.sourceLabel || "unknown"),
        checkedAt: input.metadata?.checkedAt || null,
        notes: input.metadata?.notes || ""
      },
      blockedSites: Array.isArray(input.blockedSites)
        ? input.blockedSites
            .map((entry, index) => ({
              id: String(entry.id || `site-${index + 1}`),
              type: String(entry.type || "domain"),
              value: String(entry.value || "").trim().toLowerCase(),
              source: String(entry.source || "unspecified"),
              note: String(entry.note || "")
            }))
            .filter((entry) => entry.value)
        : [],
      dictionary: Array.isArray(input.dictionary)
        ? input.dictionary
            .map((entry, index) => ({
              id: String(entry.id || `rule-${index + 1}`),
              lemma: String(entry.lemma || `rule-${index + 1}`),
              severity: String(entry.severity || "medium"),
              replacement: String(entry.replacement || "нежелательное выражение"),
              allowMultiword: Boolean(entry.allowMultiword),
              terms: Array.isArray(entry.terms)
                ? uniqueStrings(entry.terms.map((item) => String(item || "").trim()).filter(Boolean))
                : [],
              patterns: Array.isArray(entry.patterns)
                ? uniqueStrings(entry.patterns.map((item) => String(item || "").trim()).filter(Boolean))
                : []
            }))
            .filter((entry) => entry.patterns.length > 0 || entry.terms.length > 0)
        : [],
      exceptions: Array.isArray(input.exceptions)
        ? uniqueStrings(input.exceptions.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean))
        : []
    };
  }

  function isTrustedHost(hostname, trustedSites) {
    const host = normalizeHost(hostname);
    if (!host) {
      return false;
    }

    return (trustedSites || []).some((item) => host === item || host.endsWith(`.${item}`));
  }

  function isEditableElement(element) {
    if (!element) {
      return false;
    }

    const tagName = element.tagName ? element.tagName.toUpperCase() : "";
    return element.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(tagName);
  }

  function shouldSkipTextNode(node) {
    if (!node || !node.parentElement) {
      return true;
    }

    const parent = node.parentElement;
    const tagName = parent.tagName ? parent.tagName.toUpperCase() : "";
    if (["SCRIPT", "STYLE", "NOSCRIPT", "TITLE", "CODE", "PRE"].includes(tagName)) {
      return true;
    }

    return isEditableElement(parent);
  }

  global.CenzControlShared = {
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    STRICTNESS_RANK,
    deepClone,
    uniqueStrings,
    normalizeHost,
    normalizeToken,
    normalizeTextWithMap,
    getHostnameFromUrl,
    shouldUseRule,
    sanitizeStringList,
    formatDateTime,
    escapeHtml,
    createDefaultBundle,
    normalizeBundle,
    isTrustedHost,
    shouldSkipTextNode
  };
})(globalThis);
