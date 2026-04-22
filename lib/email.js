const RESEND_API_URL = "https://api.resend.com/emails";

const STATUS_LABELS = {
  PAGADO: "Pago Confirmado",
  CONFIRMADO: "Pago Confirmado",
  CONFIRMADO_SINPE: "Pago Confirmado (SINPE)",
  ENTREGADO: "Almuerzo Entregado"
};

function buildEmailHtml({ buyerName, orderId, statusLabel, cafeteriaName }) {
  const shortId = String(orderId).slice(0, 8).toUpperCase();
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:sans-serif;background:#f5f5f5;margin:0;padding:24px">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:8px;padding:32px">
    <h2 style="color:#a33d4d;margin-top:0">${cafeteriaName}</h2>
    <p>Hola <strong>${buyerName}</strong>,</p>
    <p>Tu pedido ha sido actualizado:</p>
    <div style="background:#fdf6f7;border-left:4px solid #a33d4d;padding:16px;border-radius:4px;margin:20px 0">
      <p style="margin:0 0 8px"><strong>Pedido:</strong> #${shortId}</p>
      <p style="margin:0;font-size:1.1em"><strong>Estado:</strong> ${statusLabel}</p>
    </div>
    <p style="color:#666;font-size:0.9em">Gracias por tu compra.</p>
  </div>
</body>
</html>`;
}

/**
 * Sends a status-update email to the buyer via Resend.
 * Never throws — a failed email must not block the DB update.
 *
 * @param {{ to: string, buyerName: string, orderId: string, status: string }} params
 * @returns {Promise<{ sent: boolean, error?: string }>}
 */
export async function sendOrderStatusEmail({ to, buyerName, orderId, status }) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL || "notificaciones@resend.dev";
  const cafeteriaName = process.env.CAFETERIA_NAME || "Almuerzos";

  if (!apiKey || !to) {
    return { sent: false, error: "Missing RESEND_API_KEY or recipient email." };
  }

  const statusLabel = STATUS_LABELS[String(status).toUpperCase()] || status;

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
        subject: `${statusLabel} — Pedido #${String(orderId).slice(0, 8).toUpperCase()}`,
        html: buildEmailHtml({ buyerName, orderId, statusLabel, cafeteriaName })
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
