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
        var res     = await fetch(baseUrl() + path, {
          method:  (options && options.method) || "GET",
          headers: buildHeaders(hasBody),
          body:    hasBody ? JSON.stringify(options.body) : undefined
        });

        var payload = await res.json().catch(function () { return null; });
        if (!res.ok) {
          throw new Error((payload && payload.message) || "No fue posible completar la solicitud.");
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
