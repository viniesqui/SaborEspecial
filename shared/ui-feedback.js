(function () {
  "use strict";

  window.SE = window.SE || {};

  // WS-06 R-06-2: canonical inline-feedback writer.
  // Signature: set(el, msg, level) where level ∈ {'info','success','error'}.
  // Colors sourced from CSS custom properties (defined in styles.css :root).
  // A null/missing element is a no-op so callers don't need to null-guard.

  var LEVEL_COLORS = {
    info:    "var(--muted)",
    success: "var(--success)",
    error:   "var(--primary-dark)"
  };

  window.SE.feedback = {
    set: function (el, msg, level) {
      if (!el) return;
      el.textContent = msg || "";
      el.style.color = LEVEL_COLORS[level] || LEVEL_COLORS.info;
    }
  };
})();
