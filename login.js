(function () {
  "use strict";

  var config = window.APP_CONFIG || {};

  var els = {
    form:     document.getElementById("loginForm"),
    email:    document.getElementById("loginEmail"),
    password: document.getElementById("loginPassword"),
    submit:   document.getElementById("loginSubmit"),
    feedback: document.getElementById("loginFeedback")
  };

  function setFeedback(message, isError) {
    els.feedback.textContent = message || "";
    els.feedback.style.color = isError ? "#842f3d" : "#705d52";
  }

  async function submitLogin(event) {
    event.preventDefault();

    var email    = String(els.email.value    || "").trim();
    var password = String(els.password.value || "").trim();

    if (!email || !password) {
      setFeedback("Ingrese su correo y contraseña.", true);
      return;
    }

    els.submit.disabled = true;
    setFeedback("Verificando acceso...", false);

    try {
      // 1. Authenticate — returns a session with access_token.
      var authResult = await window.supabaseClient.auth.signInWithPassword({ email: email, password: password });
      var authError  = authResult.error;
      var authData   = authResult.data;

      if (authError || !authData.session) {
        throw new Error((authError && authError.message) || "Credenciales incorrectas.");
      }

      var token = authData.session.access_token;

      // 2. Resolve role + redirect route from the server.
      var res     = await fetch(config.apiBaseUrl + "/auth-role", {
        headers: { "Authorization": "Bearer " + token }
      });
      var payload = await res.json().catch(function () { return null; });

      if (!res.ok || !payload || !payload.ok) {
        throw new Error((payload && payload.message) || "No fue posible determinar el rol.");
      }

      // route is returned by the server; no client-side ROLE_ROUTE_MAP needed.
      window.location.replace(payload.route);
    } catch (error) {
      setFeedback(error.message, true);
      els.submit.disabled = false;
    }
  }

  // Skip login if a valid session already exists.
  async function redirectIfAuthenticated() {
    if (!window.supabaseClient) return;

    var sessionResult = await window.supabaseClient.auth.getSession();
    var session       = sessionResult.data && sessionResult.data.session;
    if (!session) return;

    try {
      var res     = await fetch(config.apiBaseUrl + "/auth-role", {
        headers: { "Authorization": "Bearer " + session.access_token }
      });
      var payload = await res.json().catch(function () { return null; });
      if (payload && payload.ok && payload.route) {
        window.location.replace(payload.route);
      }
    } catch (_) {
      // Session exists but role lookup failed — stay on login.
    }
  }

  redirectIfAuthenticated();
  els.form.addEventListener("submit", submitLogin);
})();
