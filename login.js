(function () {
  "use strict";

  const config = window.APP_CONFIG || {};
  const ROLE_ROUTE_MAP = {
    ADMIN:  "./admin.html",
    HELPER: "./helper.html",
    ORDERS: "./deliveries.html"
  };

  const els = {
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

    const email    = String(els.email.value    || "").trim();
    const password = String(els.password.value || "").trim();

    if (!email || !password) {
      setFeedback("Ingrese su correo y contraseña.", true);
      return;
    }

    els.submit.disabled = true;
    setFeedback("Verificando acceso...", false);

    try {
      // 1. Authenticate with Supabase — returns a session with access_token.
      const { data: authData, error: authError } =
        await window.supabaseClient.auth.signInWithPassword({ email, password });

      if (authError || !authData.session) {
        throw new Error(authError?.message || "Credenciales incorrectas.");
      }

      const token = authData.session.access_token;

      // 2. Fetch the user's cafeteria role from our API.
      //    /api/auth-role verifies the JWT server-side and reads cafeteria_users.
      const res = await fetch(config.apiBaseUrl + "/auth-role", {
        headers: { "Authorization": "Bearer " + token }
      });

      const payload = await res.json().catch(function () { return null; });
      if (!res.ok || !payload?.ok) {
        throw new Error((payload && payload.message) || "No fue posible determinar el rol.");
      }

      // 3. Supabase persists the session automatically in localStorage.
      //    No password or role is stored manually — just redirect.
      window.location.replace(payload.route);
    } catch (error) {
      setFeedback(error.message, true);
      els.submit.disabled = false;
    }
  }

  // If a valid Supabase session already exists, skip the login form.
  async function redirectIfAuthenticated() {
    if (!window.supabaseClient) return;

    const { data: { session } } = await window.supabaseClient.auth.getSession();
    if (!session) return;

    try {
      const res = await fetch(config.apiBaseUrl + "/auth-role", {
        headers: { "Authorization": "Bearer " + session.access_token }
      });
      const payload = await res.json().catch(function () { return null; });
      if (payload?.ok && ROLE_ROUTE_MAP[payload.role]) {
        window.location.replace(payload.route);
      }
    } catch (_) {
      // Session exists but role lookup failed — stay on login page.
    }
  }

  redirectIfAuthenticated();
  els.form.addEventListener("submit", submitLogin);
})();
