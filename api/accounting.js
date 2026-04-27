import { supabase }             from "../lib/supabase.js";
import { handleOptions, setCors } from "../lib/http.js";
import { requireAuth }           from "../lib/auth.js";

const PAID = ["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE"];

// Returns { month, fromDate, toDate } for a given "YYYY-MM" string.
// Falls back to the current Costa Rica month when omitted.
function getMonthRange(month) {
  let m = month;
  if (!m || !/^\d{4}-\d{2}$/.test(m)) {
    m = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString().slice(0, 7);
  }
  const [y, mo] = m.split("-").map(Number);
  const fromDate = `${y}-${String(mo).padStart(2, "0")}-01`;
  const toDate   = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
  return { month: m, fromDate, toDate };
}

// Generates actionable recommendations from the aggregated report data.
function buildRecommendations({ daily, summary, settings }) {
  const recs = [];

  // 1. Package stability
  if (summary.totalMealsSold > 10) {
    const pct = summary.packageRevenuePct;
    if (pct < 20) {
      const weeksInMonth = Math.ceil(summary.activeDays / 5);
      const extraPerWeek = Math.max(1, Math.round((summary.totalMealsSold * 0.3 - summary.creditMeals) / Math.max(1, weeksInMonth)));
      recs.push({
        type:     "package_stability",
        priority: "high",
        title:    "Potencial de ingresos estables sin explotar",
        message:  `Los paquetes representan solo el ${pct}% de tus ventas este mes. ` +
                  `Aumentar esto al 30% garantizaría aproximadamente ${extraPerWeek} ventas más ` +
                  `por semana sin depender de clientes nuevos cada día.`
      });
    } else if (pct >= 30) {
      recs.push({
        type:     "package_strength",
        priority: "info",
        title:    "Buena base de ingresos garantizados",
        message:  `Excelente: el ${pct}% de tus almuerzos este mes vinieron de paquetes prepagados. ` +
                  `Eso significa ingresos predecibles y menos incertidumbre diaria.`
      });
    }
  }

  // 2. Low-margin dish (only when cost data is present)
  const daysWithCost = daily.filter(d => d.costPerDish > 0 && d.menuPrice > 0);
  if (daysWithCost.length > 0) {
    let worstMargin = 100;
    let worstDay    = null;
    daysWithCost.forEach(d => {
      const margin = ((d.menuPrice - d.costPerDish) / d.menuPrice) * 100;
      if (margin < worstMargin) { worstMargin = margin; worstDay = d; }
    });
    if (worstMargin < 30 && worstDay) {
      const suggestedPrice = Math.ceil(worstDay.costPerDish / 0.65 / 100) * 100;
      recs.push({
        type:     "low_margin",
        priority: "medium",
        title:    "Margen bajo detectado",
        message:  `Tu menú "${worstDay.menuTitle}" tiene un margen estimado de solo ${Math.round(worstMargin)}%. ` +
                  `Con un costo de ₡${worstDay.costPerDish.toLocaleString("es-CR")}, ` +
                  `un precio de al menos ₡${suggestedPrice.toLocaleString("es-CR")} daría un margen del 35%.`
      });
    }
  }

  // 3. Waste reduction
  if (summary.avgWaste > 3 && summary.activeDays >= 3) {
    const suggested = Math.max(1, settings.max_meals - Math.round(summary.avgWaste * 0.6));
    const revLoss   = Math.round(summary.avgWaste * (summary.grossRevenue / Math.max(1, summary.totalMealsSold)));
    recs.push({
      type:     "waste_reduction",
      priority: "medium",
      title:    "Cupos sin vender cada día",
      message:  `En promedio quedan ${Math.round(summary.avgWaste)} cupos sin vender por día ` +
                `(de ${settings.max_meals} autorizados). Reducir el cupo a ${suggested} ` +
                `eliminaría ese vacío sin rechazar clientes, y evitaría preparar comida de más.`
    });
  }

  // 4. No cost data entered
  if (daysWithCost.length === 0 && summary.activeDays > 0) {
    recs.push({
      type:     "missing_costs",
      priority: "info",
      title:    "Ingresa el costo por plato para ver tu margen real",
      message:  `Tienes ${summary.activeDays} días con ventas este mes pero ninguno tiene costo estimado. ` +
                `Agrega el costo de ingredientes + labor en el formulario del menú para ver ` +
                `cuánto ganás realmente en cada almuerzo.`
    });
  }

  return recs;
}

export default async function handler(req, res) {
  if (handleOptions(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const { cafeteriaId }           = await requireAuth(req, ["ADMIN"]);
    const { month }                 = req.body || {};
    const { month: m, fromDate, toDate } = getMonthRange(month);

    const [ordersRes, menusRes, settingsRes] = await Promise.all([
      supabase
        .from("orders")
        .select(
          "id, target_date, sale_type, payment_method, payment_status, " +
          "menu_price, record_status, package_id, packages(price, meal_count)"
        )
        .eq("cafeteria_id", cafeteriaId)
        .gte("target_date", fromDate)
        .lte("target_date", toDate),
      supabase
        .from("menus")
        .select("day_key, title, price, cost_per_dish")
        .eq("cafeteria_id", cafeteriaId)
        .gte("day_key", fromDate)
        .lte("day_key", toDate)
        .eq("active", true),
      supabase
        .from("settings")
        .select("max_meals")
        .eq("cafeteria_id", cafeteriaId)
        .single()
    ]);

    if (ordersRes.error)   throw ordersRes.error;
    if (menusRes.error)    throw menusRes.error;

    const allOrders = ordersRes.data  || [];
    const menus     = menusRes.data   || [];
    const settings  = settingsRes.data || { max_meals: 15 };

    const menuByDay = {};
    menus.forEach(m => { menuByDay[m.day_key] = m; });

    // Weighted-average per-meal value from confirmed package sales.
    // This is used to correctly value CREDIT_REDEMPTION orders for accounting.
    const confirmedPkg = allOrders.filter(
      o => o.sale_type === "PACKAGE_SALE" &&
           PAID.includes(o.payment_status) &&
           o.record_status !== "CANCELADO" &&
           o.packages
    );
    const totalPkgRevenue = confirmedPkg.reduce((s, o) => s + Number(o.packages.price      || 0), 0);
    const totalPkgMeals   = confirmedPkg.reduce((s, o) => s + Number(o.packages.meal_count || 0), 0);
    const avgCreditValue  = totalPkgMeals > 0 ? totalPkgRevenue / totalPkgMeals : 0;

    const activeOrders    = allOrders.filter(o => o.record_status !== "CANCELADO");
    const cancelledOrders = allOrders.filter(o => o.record_status === "CANCELADO" && o.sale_type !== "PACKAGE_SALE");

    // Unique service dates (days when meals were served, excluding package-sale-only days).
    const activeDates = [...new Set(
      activeOrders
        .filter(o => o.sale_type !== "PACKAGE_SALE")
        .map(o => o.target_date)
    )].sort();

    // --- Daily breakdown ---
    let totalSinpe = 0, totalCash = 0, totalCredit = 0;
    let totalCosts = 0, totalMealsSold = 0, totalWaste = 0;
    let alacarteMeals = 0, creditMeals = 0;

    const daily = activeDates.map(date => {
      const dayOrders = activeOrders.filter(
        o => o.target_date === date && o.sale_type !== "PACKAGE_SALE"
      );
      const menu = menuByDay[date] || {};

      const sinpeOrders  = dayOrders.filter(o => o.payment_method === "SINPE"    && o.sale_type === "SINGLE_SALE");
      const cashOrders   = dayOrders.filter(o => o.payment_method === "EFECTIVO" && o.sale_type === "SINGLE_SALE");
      const creditOrders = dayOrders.filter(o => o.sale_type === "CREDIT_REDEMPTION");

      const sinpeRevenue  = sinpeOrders.reduce( (s, o) => s + Number(o.menu_price || 0), 0);
      const cashRevenue   = cashOrders.reduce(  (s, o) => s + Number(o.menu_price || 0), 0);
      // Value each credit redemption at the package's per-meal rate (or menu price as fallback).
      const creditRevenue = creditOrders.length * (avgCreditValue || Number(menu.price || 0));

      const grossRevenue    = sinpeRevenue + cashRevenue + creditRevenue;
      const mealsSold       = dayOrders.length;
      const wastedMeals     = Math.max(0, settings.max_meals - mealsSold);
      const costPerDish     = Number(menu.cost_per_dish || 0);
      const estimatedCost   = costPerDish > 0 ? mealsSold * costPerDish : null;
      const estimatedProfit = estimatedCost !== null ? grossRevenue - estimatedCost : null;
      const profitMarginPct = (estimatedProfit !== null && grossRevenue > 0)
        ? Math.round((estimatedProfit / grossRevenue) * 100) : null;

      totalSinpe     += sinpeRevenue;
      totalCash      += cashRevenue;
      totalCredit    += creditRevenue;
      if (estimatedCost !== null) totalCosts += estimatedCost;
      totalMealsSold += mealsSold;
      totalWaste     += wastedMeals;
      alacarteMeals  += sinpeOrders.length + cashOrders.length;
      creditMeals    += creditOrders.length;

      return {
        date,
        menuTitle:         menu.title  || "Sin menú",
        menuPrice:         Number(menu.price || 0),
        costPerDish,
        maxMeals:          settings.max_meals,
        mealsSold,
        wastedMeals,
        alacarteSales:     sinpeOrders.length + cashOrders.length,
        creditRedemptions: creditOrders.length,
        sinpeRevenue,
        cashRevenue,
        creditRevenue:     Math.round(creditRevenue),
        grossRevenue:      Math.round(grossRevenue),
        estimatedCost:     estimatedCost !== null ? Math.round(estimatedCost) : null,
        estimatedProfit:   estimatedProfit !== null ? Math.round(estimatedProfit) : null,
        profitMarginPct
      };
    });

    const grossRevenue    = totalSinpe + totalCash + totalCredit;
    const hasCostData     = totalCosts > 0;
    const estimatedProfit = hasCostData ? grossRevenue - totalCosts : null;

    const summary = {
      grossRevenue:         Math.round(grossRevenue),
      cashRevenue:          Math.round(totalCash),
      sinpeRevenue:         Math.round(totalSinpe),
      creditRevenue:        Math.round(totalCredit),
      estimatedCosts:       hasCostData ? Math.round(totalCosts) : null,
      estimatedProfit:      estimatedProfit !== null ? Math.round(estimatedProfit) : null,
      profitMarginPct:      (estimatedProfit !== null && grossRevenue > 0)
                              ? Math.round((estimatedProfit / grossRevenue) * 100) : null,
      totalMealsSold,
      alacarteMeals,
      creditMeals,
      packageRevenuePct:    totalMealsSold > 0 ? Math.round((creditMeals / totalMealsSold) * 100) : 0,
      totalWastedMeals:     totalWaste,
      avgWaste:             activeDates.length > 0 ? totalWaste / activeDates.length : 0,
      avgCreditValuePerMeal: Math.round(avgCreditValue),
      activeDays:           activeDates.length,
      cancelledOrders:      cancelledOrders.length
    };

    const recommendations = buildRecommendations({ daily, summary, settings });

    return res.status(200).json({
      ok:             true,
      month:          m,
      fromDate,
      toDate,
      updatedAt:      new Date().toISOString(),
      summary,
      daily,
      recommendations
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ ok: false, message: error.message });
    return res.status(500).json({ ok: false, message: error.message || "Error al generar el reporte contable." });
  }
}
