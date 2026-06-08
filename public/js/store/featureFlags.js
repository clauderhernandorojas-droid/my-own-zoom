/**
 * Feature flags de módulos de sala (query + localStorage overrides).
 */
(function (global) {
  const STORAGE_KEY = "moj_dev_flags";

  const DEFAULTS = {
    enableChat: true,
    enableParticipantsPanel: true,
    enableScreenShare: true,
    enableModularLayout: true,
  };

  const ALIASES = {
    noChat: { enableChat: false },
    noParticipants: { enableParticipantsPanel: false },
    noScreenShare: { enableScreenShare: false },
    noModularLayout: { enableModularLayout: false },
  };

  function parseList(raw) {
    if (!raw) return [];
    return String(raw)
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function fromQuery() {
    try {
      const q = global.location?.search || "";
      const params = new URLSearchParams(q);
      const flagsParam = params.get("flags");
      if (!flagsParam) return {};
      const out = { ...DEFAULTS };
      parseList(flagsParam).forEach((token) => {
        const neg = token.startsWith("no") ? token : `no${token.charAt(0).toUpperCase()}${token.slice(1)}`;
        if (ALIASES[token]) Object.assign(out, ALIASES[token]);
        else if (ALIASES[neg]) Object.assign(out, ALIASES[neg]);
      });
      return out;
    } catch (_) {
      return {};
    }
  }

  function fromStorage() {
    try {
      const raw = global.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  function resolve(overrides = {}) {
    return {
      ...DEFAULTS,
      ...fromStorage(),
      ...fromQuery(),
      ...overrides,
    };
  }

  global.FeatureFlags = {
    DEFAULTS,
    resolve,
    STORAGE_KEY,
  };
})(typeof window !== "undefined" ? window : global);
