const SHEET_NAMES = {
  SETTINGS: 'Settings',
  ORDERS: 'Orders'
};

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'dashboard';
    return jsonResponse(handleAction(action, null));
  } catch (error) {
    return jsonResponse({
      ok: false,
      message: error.message || 'Error inesperado.'
    });
  }
}

function doPost(e) {
  try {
    const payload = parseJsonBody_(e);
    const action = payload.action || 'dashboard';
    return jsonResponse(handleAction(action, payload));
  } catch (error) {
    return jsonResponse({
      ok: false,
      message: error.message || 'Error inesperado.'
    });
  }
}

function handleAction(action, payload) {
  if (action === 'dashboard') {
    return buildDashboardSnapshot_();
  }

  if (action === 'createOrder') {
    return createOrder_(payload.order || {});
  }

  return {
    ok: false,
    message: 'Accion no soportada.'
  };
}

function createOrder_(order) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const settings = getSettingsMap_(spreadsheet);
    const ordersSheet = getOrCreateOrdersSheet_(spreadsheet);
    const now = new Date();
    const todayKey = Utilities.formatDate(now, settings.timezone, 'yyyy-MM-dd');

    validateOrder_(order);

    const snapshot = buildDashboardSnapshot_();
    if (!snapshot.isSalesOpen) {
      return { ok: false, message: 'La venta de almuerzos esta cerrada.' };
    }

    if (snapshot.availableMeals <= 0) {
      return { ok: false, message: 'Ya no hay almuerzos disponibles para hoy.' };
    }

    const orderId = 'ALM-' + Utilities.formatDate(now, settings.timezone, 'HHmmss') + '-' + Math.floor(Math.random() * 900 + 100);
    const paymentStatus = order.paymentMethod === 'SINPE' ? 'POR_VERIFICAR' : 'PENDIENTE_ENTREGA';
    const menu = getMenuFromSettings_(settings);

    ordersSheet.appendRow([
      new Date(),
      todayKey,
      orderId,
      order.buyerName,
      order.buyerId,
      order.buyerPhone,
      order.paymentMethod,
      paymentStatus,
      order.paymentReference || '',
      order.notes || '',
      menu.title,
      menu.description,
      Number(menu.price || 0),
      'ACTIVO'
    ]);

    const freshSnapshot = buildDashboardSnapshot_();
    return {
      ok: true,
      message: 'Compra registrada. Codigo: ' + orderId,
      snapshot: freshSnapshot
    };
  } finally {
    lock.releaseLock();
  }
}

function buildDashboardSnapshot_() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const settings = getSettingsMap_(spreadsheet);
  const ordersSheet = getOrCreateOrdersSheet_(spreadsheet);
  const data = ordersSheet.getDataRange().getValues();
  const rows = data.length > 1 ? data.slice(1) : [];
  const timezone = settings.timezone;
  const now = new Date();
  const todayKey = Utilities.formatDate(now, timezone, 'yyyy-MM-dd');
  const menu = getMenuFromSettings_(settings);
  const maxMeals = Number(settings.maxMeals || 15);
  const salesStart = settings.salesStart || '10:00';
  const salesEnd = settings.salesEnd || '12:00';
  const deliveryWindow = settings.deliveryWindow || '12:00 - 12:30';

  const todayOrders = rows
    .map(mapOrderRow_)
    .filter((row) => row.dayKey === todayKey && row.recordStatus !== 'CANCELADO');

  const soldMeals = todayOrders.length;
  const availableMeals = Math.max(maxMeals - soldMeals, 0);
  const counts = todayOrders.reduce(function (acc, item) {
    if (item.paymentMethod === 'SINPE') acc.sinpe += 1;
    if (item.paymentMethod === 'EFECTIVO') acc.cash += 1;
    acc.total += Number(item.menuPrice || 0);
    return acc;
  }, { sinpe: 0, cash: 0, total: 0 });

  return {
    ok: true,
    updatedAt: new Date().toISOString(),
    isSalesOpen: isSalesOpen_(now, salesStart, salesEnd, timezone) && availableMeals > 0,
    availableMeals: availableMeals,
    soldMeals: soldMeals,
    sinpeCount: counts.sinpe,
    cashCount: counts.cash,
    totalAmount: counts.total,
    message: settings.message || 'Venta maxima de 15 almuerzos por dia.',
    salesWindow: salesStart + ' - ' + salesEnd,
    deliveryWindow: deliveryWindow,
    menu: menu,
    orders: todayOrders.map(function (item) {
      return {
        buyerName: item.buyerName,
        paymentMethod: item.paymentMethod,
        paymentStatus: item.paymentStatus,
        timestampLabel: formatTimestamp_(item.timestamp, timezone)
      };
    })
  };
}

function getSettingsMap_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(SHEET_NAMES.SETTINGS);
  if (!sheet) {
    throw new Error('Falta la hoja Settings. Revise el README para crearla.');
  }

  const values = sheet.getDataRange().getValues();
  const map = {};

  for (let i = 1; i < values.length; i += 1) {
    const key = String(values[i][0] || '').trim();
    if (!key) continue;
    map[key] = values[i][1];
  }

  map.timezone = map.timezone || Session.getScriptTimeZone() || 'America/Costa_Rica';
  return map;
}

function getMenuFromSettings_(settings) {
  return {
    title: settings.menuTitle || 'Casado del dia',
    description: settings.menuDescription || 'Menu no configurado.',
    price: Number(settings.menuPrice || 0)
  };
}

function getOrCreateOrdersSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(SHEET_NAMES.ORDERS);
  if (sheet) return sheet;

  sheet = spreadsheet.insertSheet(SHEET_NAMES.ORDERS);
  sheet.appendRow([
    'timestamp',
    'dayKey',
    'orderId',
    'buyerName',
    'buyerId',
    'buyerPhone',
    'paymentMethod',
    'paymentStatus',
    'paymentReference',
    'notes',
    'menuTitle',
    'menuDescription',
    'menuPrice',
    'recordStatus'
  ]);
  return sheet;
}

function mapOrderRow_(row) {
  return {
    timestamp: row[0],
    dayKey: row[1],
    orderId: row[2],
    buyerName: row[3],
    buyerId: row[4],
    buyerPhone: row[5],
    paymentMethod: row[6],
    paymentStatus: row[7],
    paymentReference: row[8],
    notes: row[9],
    menuTitle: row[10],
    menuDescription: row[11],
    menuPrice: row[12],
    recordStatus: row[13]
  };
}

function validateOrder_(order) {
  if (!order.buyerName || !order.buyerId || !order.buyerPhone || !order.paymentMethod) {
    throw new Error('Faltan datos obligatorios.');
  }
}

function isSalesOpen_(now, salesStart, salesEnd, timezone) {
  const today = Utilities.formatDate(now, timezone, 'yyyy-MM-dd');
  const start = new Date(today + 'T' + normalizeTime_(salesStart) + ':00');
  const end = new Date(today + 'T' + normalizeTime_(salesEnd) + ':00');
  return now >= start && now <= end;
}

function normalizeTime_(value) {
  const clean = String(value || '').trim();
  return clean.length === 4 ? '0' + clean : clean;
}

function formatTimestamp_(value, timezone) {
  if (!value) return '';
  return Utilities.formatDate(new Date(value), timezone, 'HH:mm');
}

function parseJsonBody_(e) {
  if (!e || !e.postData || !e.postData.contents) return {};
  return JSON.parse(e.postData.contents);
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
