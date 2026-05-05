(function () {
  "use strict";

  window.SE = window.SE || {};

  // Returns an API client bound to a token getter function.
  // Pass null as getToken for unauthenticated (public) endpoints.
  //
  // Usage:
  //   const api = window.SE.api.make(() => accessToken);
  //   const data = await api.fetchJson("/deliveries");
  //   await api.downloadFile("/orders-export", {}, "orders.csv");

  window.SE.api = {
    make: function (getToken) {
      function baseUrl() {
        var cfg = window.APP_CONFIG || {};
        if (!cfg.apiBaseUrl || cfg.apiBaseUrl.includes("PEGUE_AQUI")) {
          throw new Error("Debe configurar la URL del backend en config.js");
        }
        return cfg.apiBaseUrl;
      }

      function buildHeaders(withBody) {
        var headers = {};
        var token   = getToken ? getToken() : null;
        if (token)    headers["Authorization"]  = "Bearer " + token;
        if (withBody) headers["Content-Type"]   = "application/json";
        return headers;
      }

      async function fetchJson(path, options) {
        var hasBody = options && options.body !== undefined;
        var res, payload;

        try {
          res = await fetch(baseUrl() + path, {
            method:  (options && options.method) || "GET",
            headers: buildHeaders(hasBody),
            body:    hasBody ? JSON.stringify(options.body) : undefined
          });
        } catch (_) {
          // Network-level failure (offline, DNS, timeout) — retrying may help.
          var netErr      = new Error("Sin conexión con el servidor. Verifica tu internet.");
          netErr.retryable = true;
          throw netErr;
        }

        payload = await res.json().catch(function () { return null; });

        if (!res.ok) {
          // Server returned a JSON body with a message → known error, show text as-is.
          // No retry: sending the exact same request again will produce the same failure.
          // Bare 5xx with no JSON body → transient infra error, retry may help.
          var serverMsg   = payload && payload.message;
          var err         = new Error(serverMsg || "No fue posible completar la solicitud.");
          err.retryable   = !serverMsg;
          throw err;
        }

        return payload;
      }

      async function downloadFile(path, body, filename) {
        var res = await fetch(baseUrl() + path, {
          method:  "POST",
          headers: buildHeaders(true),
          body:    JSON.stringify(body || {})
        });

        if (!res.ok) {
          var j = await res.json().catch(function () { return null; });
          throw new Error((j && j.message) || "No fue posible exportar el archivo.");
        }

        var blob = await res.blob();
        var url  = window.URL.createObjectURL(blob);
        var a    = document.createElement("a");
        a.href     = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);
      }

      return { fetchJson: fetchJson, downloadFile: downloadFile };
    }
  };
})();
