(function () {
  "use strict";

  window.SE = window.SE || {};

  window.SE.banner = (function () {
    function get() {
      return document.getElementById("statusBanner");
    }

    function init() {
      var b = get();
      if (!b) return;

      function sync() {
        if (!navigator.onLine) {
          b.dataset.state = "offline";
          b.textContent   = "Sin conexión — mostrando datos guardados";
        } else if (b.dataset.state === "offline") {
          delete b.dataset.state;
          b.textContent = "";
        }
      }

      window.addEventListener("online",  sync);
      window.addEventListener("offline", sync);
      sync();
    }

    function setSyncing() {
      var b = get();
      if (!b) return;
      b.dataset.state = "syncing";
      b.textContent   = "Sincronizando...";
    }

    function setSynced() {
      var b = get();
      if (!b) return;
      b.dataset.state = "synced";
      b.textContent   = "Sincronizado a las " +
        new Date().toLocaleTimeString("es-CR", { hour: "2-digit", minute: "2-digit" });
      setTimeout(function () {
        delete b.dataset.state;
        b.textContent = "";
      }, 3000);
    }

    function setError(retryFn) {
      var b = get();
      if (!b) return;
      b.dataset.state = "error";
      b.textContent   = "Error al sincronizar — toca para reintentar";
      b.onclick = function () {
        b.onclick = null;
        if (retryFn) retryFn();
      };
    }

    return { init: init, setSyncing: setSyncing, setSynced: setSynced, setError: setError };
  })();
})();
