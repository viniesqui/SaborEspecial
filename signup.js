(function () {
  "use strict";

  var els = {
    form:           document.getElementById("signupForm"),
    cafeteriaName:  document.getElementById("signupCafeteriaName"),
    email:          document.getElementById("signupEmail"),
    password:       document.getElementById("signupPassword"),
    submit:         document.getElementById("signupSubmit"),
    feedback:       document.getElementById("signupFeedback")
  };

  function setFeedback(message, isError) {
    els.feedback.textContent = message || "";
    els.feedback.style.color = isError ? "#842f3d" : "#705d52";
  }

  async function submitSignup(event) {
    event.preventDefault();

    var cafeteriaName = String(els.cafeteriaName.value || "").trim();
    var email         = String(els.email.value         || "").trim();
    var password      = String(els.password.value      || "").trim();

    if (!cafeteriaName || !email || !password) {
      setFeedback("Complete todos los campos.", true);
      return;
    }
    if (password.length < 8) {
      setFeedback("La contraseña debe tener al menos 8 caracteres.", true);
      return;
    }

    els.submit.disabled = true;
    setFeedback("Creando cuenta...", false);

    try {
      var result = await window.supabaseClient.auth.signUp({
        email:    email,
        password: password,
        options: {
          // The handle_new_user() trigger reads cafeteria_name from
          // raw_user_meta_data and provisions the cafeteria + ADMIN
          // membership + settings + placeholder menus.
          data: { cafeteria_name: cafeteriaName }
        }
      });

      if (result.error) {
        throw new Error(result.error.message || "No se pudo crear la cuenta.");
      }

      var session = result.data && result.data.session;

      if (session) {
        // Email confirmation disabled — user is already logged in.
        setFeedback("¡Cuenta creada! Redirigiendo...", false);
        window.location.replace("./management.html");
        return;
      }

      // Email confirmation enabled — show next-steps message.
      setFeedback(
        "¡Cuenta creada! Revisa tu correo para confirmar la cuenta y luego inicia sesión.",
        false
      );
      els.form.reset();
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      els.submit.disabled = false;
    }
  }

  // If a session already exists, send them straight to management.
  async function redirectIfAuthenticated() {
    if (!window.supabaseClient) return;
    var sessionResult = await window.supabaseClient.auth.getSession();
    if (sessionResult.data && sessionResult.data.session) {
      window.location.replace("./management.html");
    }
  }

  redirectIfAuthenticated();
  els.form.addEventListener("submit", submitSignup);
})();
