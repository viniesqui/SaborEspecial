(function () {
  "use strict";

  const config = window.APP_CONFIG || {};
  const SESSION_KEY = "ceep-role-session";
  const ROLE_ROUTE_MAP = {
    CUSTOMER: "./customer.html",
    HELPER: "./helper.html",
    ADMIN: "./admin.html",
    ORDERS: "./deliveries.html"
  };
  const els = {
    form: document.getElementById("loginForm"),
    password: document.getElementById("loginPassword"),
    submit: document.getElementById("loginSubmit"),
    feedback: document.getElementById("loginFeedback")
  };

  function setFeedback(message, isError) {
    els.feedback.textContent = message || "";
    els.feedback.style.color = isError ? "#842f3d" : "#705d52";
  }

  function getSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  async function fetchJson(path, options) {
    const response = await fetch(config.apiBaseUrl + path, {
      method: options?.method || "GET",
      headers: {
        "Content-Type": "application/json"
      },
      body: options?.body ? JSON.stringify(options.body) : undefined
    });

    const payload = await response.json().catch(function () {
      return null;
    });

    if (!response.ok) {
      throw new Error((payload && payload.message) || "No fue posible completar la solicitud.");
    }

    return payload;
  }

  async function submitLogin(event) {
    event.preventDefault();
    const password = String(els.password.value || "").trim();

    if (!password) {
      setFeedback("Ingrese la clave.", true);
      return;
    }

    els.submit.disabled = true;
    setFeedback("Verificando acceso...", false);

    try {
      const result = await fetchJson("/auth-role", {
        method: "POST",
        body: { password }
      });

      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        role: result.role,
        password
      }));

      window.location.href = result.route;
    } catch (error) {
      setFeedback(error.message, true);
      els.submit.disabled = false;
    }
  }

  const session = getSession();
  if (session && session.role && ROLE_ROUTE_MAP[session.role]) {
    window.location.replace(ROLE_ROUTE_MAP[session.role]);
  }

  els.form.addEventListener("submit", submitLogin);
})();
