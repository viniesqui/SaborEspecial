const RESEND_API_URL = "https://api.resend.com/emails";

const STATUS_LABELS = {
  SOLICITADO: "Pedido Recibido",
  PAGADO: "Pago Confirmado",
  CONFIRMADO: "Pago Confirmado",
  CONFIRMADO_SINPE: "Pago Confirmado",
  EN_PREPARACION: "En Preparación",
  LISTO_PARA_ENTREGA: "¡Tu almuerzo está listo!",
  ENTREGADO: "Almuerzo Entregado"
};

const STATUS_MESSAGES = {
  SOLICITADO: "Recibimos tu pedido. En cuanto se confirme el pago, te avisamos.",
  PAGADO: "Tu pago fue confirmado. Ya estamos preparando tu almuerzo.",
  CONFIRMADO: "Tu pago fue confirmado. Ya estamos preparando tu almuerzo.",
  CONFIRMADO_SINPE: "Tu pago fue confirmado. Ya estamos preparando tu almuerzo.",
  EN_PREPARACION: "Tu almuerzo está en la cocina. Pronto estará listo.",
  LISTO_PARA_ENTREGA: "Pasa a buscarlo cuando gustes. ¡Te esperamos!",
  ENTREGADO: "¡Buen provecho! Gracias por tu compra."
};

function buildTrackingSection(trackingUrl) {
  if (!trackingUrl) return "";
  return `
    <div style="margin:20px 0;text-align:center">
      <a href="${trackingUrl}"
         style="display:inline-block;background:#a33d4d;color:#fff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:700;font-size:1rem">
        Ver estado de mi pedido
      </a>
      <p style="margin:10px 0 0;font-size:0.82em;color:#999">
        También puedes guardar este enlace para consultar el estado en cualquier momento.
      </p>
    </div>`;
}

function buildEmailHtml({ buyerName, statusLabel, statusMessage, cafeteriaName, trackingUrl }) {
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;background:#f5f5f5;margin:0;padding:24px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:32px">
    <h2 style="color:#a33d4d;margin-top:0">${cafeteriaName}</h2>
    <p>Hola <strong>${buyerName}</strong>,</p>
    <div style="background:#fdf6f7;border-left:4px solid #a33d4d;padding:16px;border-radius:4px;margin:20px 0">
      <p style="margin:0;font-size:1.15em;font-weight:700;color:#a33d4d">${statusLabel}</p>
      <p style="margin:8px 0 0;color:#444">${statusMessage}</p>
    </div>
    ${buildTrackingSection(trackingUrl)}
    <p style="color:#888;font-size:0.88em">¡Hasta pronto!</p>
  </div>
</body>
</html>`;
}

/**
 * Sends a status-update email to the buyer via Resend.
 * Never throws — a failed email must not block the DB update.
 *
 * @param {{ to: string, buyerName: string, orderId: string, status: string, trackingUrl?: string }} params
 * @returns {Promise<{ sent: boolean, error?: string }>}
 */
export async function sendOrderStatusEmail({ to, buyerName, orderId, status, trackingUrl }) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || "notificaciones@resend.dev";
  const cafeteriaName = process.env.CAFETERIA_NAME || "Almuerzos";

  if (!apiKey || !to) {
    return { sent: false, error: "Missing RESEND_API_KEY or recipient email." };
  }

  const statusKey = String(status).toUpperCase();
  const statusLabel   = STATUS_LABELS[statusKey]   || status;
  const statusMessage = STATUS_MESSAGES[statusKey] || "Tu pedido ha sido actualizado.";

  try {
    const response = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: `${cafeteriaName} <${fromEmail}>`,
        to: [to],
        subject: `${statusLabel} — ${cafeteriaName}`,
        html: buildEmailHtml({ buyerName, statusLabel, statusMessage, cafeteriaName, trackingUrl })
      })
    });

    if (!response.ok) {
      const body = await response.text();
      return { sent: false, error: `Resend API error ${response.status}: ${body}` };
    }

    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}
