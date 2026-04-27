import { handleOptions, setCors } from "../lib/http.js";
import { requireAuth }           from "../lib/auth.js";
import { supabase }              from "../lib/supabase.js";

const PAID = ["PAGADO", "CONFIRMADO", "CONFIRMADO_SINPE"];

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

function esc(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function buildCsv(month, summary, daily) {
  const lines = [];

  // Summary block
  lines.push(`"REPORTE DE RENTABILIDAD - ${month}"`);
  lines.push("");
  lines.push(`"Ingresos Brutos",${summary.grossRevenue}`);
  lines.push(`"  Efectivo",${summary.cashRevenue}`);
  lines.push(`"  SINPE",${summary.sinpeRevenue}`);
  lines.push(`"  Créditos (paquetes)",${summary.creditRevenue}`);
  if (summary.estimatedCosts !== null) {
    lines.push(`"Costos Estimados",${summary.estimatedCosts}`);
    lines.push(`"Ganancia Estimada",${summary.estimatedProfit}`);
    lines.push(`"Margen (%)",${summary.profitMarginPct}`);
  }
  lines.push(`"Almuerzos Vendidos",${summary.totalMealsSold}`);
  lines.push(`"  A la carta",${summary.alacarteMeals}`);
  lines.push(`"  Paquetes (créditos)",${summary.creditMeals}`);
  lines.push(`"Cupos sin vender (total)",${summary.totalWastedMeals}`);
  lines.push(`"Valor promedio por crédito (₡)",${summary.avgCreditValuePerMeal}`);
  lines.push("");

  // Daily breakdown header
  const headers = [
    "Fecha", "Menú", "Precio (₡)", "Costo por plato (₡)",
    "Cupo máx.", "Vendidos", "Sin vender",
    "A la carta", "Créditos",
    "SINPE (₡)", "Efectivo (₡)", "Créditos (₡)", "Ingresos brutos (₡)",
    "Costo total (₡)", "Ganancia estimada (₡)", "Margen (%)"
  ];
  lines.push(headers.map(esc).join(","));

  daily.forEach(d => {
    lines.push([
      d.date,
      d.menuTitle,
      d.menuPrice,
      d.costPerDish || "",
      d.maxMeals,
      d.mealsSold,
      d.wastedMeals,
      d.alacarteSales,
      d.creditRedemptions,
      d.sinpeRevenue,
      d.cashRevenue,
      d.creditRevenue,
      d.grossRevenue,
      d.estimatedCost  ?? "",
      d.estimatedProfit ?? "",
      d.profitMarginPct ?? ""
    ].map(esc).join(","));
  });

  return "﻿" + lines.join("\n");
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

    if (ordersRes.error) throw ordersRes.error;
    if (menusRes.error)  throw menusRes.error;

    const allOrders = ordersRes.data  || [];
    const menus     = menusRes.data   || [];
    const settings  = settingsRes.data || { max_meals: 15 };

    const menuByDay = {};
    menus.forEach(mu => { menuByDay[mu.day_key] = mu; });

    const confirmedPkg = allOrders.filter(
      o => o.sale_type === "PACKAGE_SALE" &&
           PAID.includes(o.payment_status) &&
           o.record_status !== "CANCELADO" &&
           o.packages
    );
    const totalPkgRevenue = confirmedPkg.reduce((s, o) => s + Number(o.packages.price      || 0), 0);
    const totalPkgMeals   = confirmedPkg.reduce((s, o) => s + Number(o.packages.meal_count || 0), 0);
    const avgCreditValue  = totalPkgMeals > 0 ? totalPkgRevenue / totalPkgMeals : 0;

    const activeOrders = allOrders.filter(o => o.record_status !== "CANCELADO");

    const activeDates = [...new Set(
      activeOrders.filter(o => o.sale_type !== "PACKAGE_SALE").map(o => o.target_date)
    )].sort();

    let totalSinpe = 0, totalCash = 0, totalCredit = 0;
    let totalCosts = 0, totalMealsSold = 0, totalWaste = 0;
    let alacarteMeals = 0, creditMeals = 0;

    const daily = activeDates.map(date => {
      const dayOrders   = activeOrders.filter(o => o.target_date === date && o.sale_type !== "PACKAGE_SALE");
      const menu        = menuByDay[date] || {};
      const sinpeOrders = dayOrders.filter(o => o.payment_method === "SINPE"    && o.sale_type === "SINGLE_SALE");
      const cashOrders  = dayOrders.filter(o => o.payment_method === "EFECTIVO" && o.sale_type === "SINGLE_SALE");
      const creditOrds  = dayOrders.filter(o => o.sale_type === "CREDIT_REDEMPTION");

      const sinpeRevenue  = sinpeOrders.reduce((s, o) => s + Number(o.menu_price || 0), 0);
      const cashRevenue   = cashOrders.reduce( (s, o) => s + Number(o.menu_price || 0), 0);
      const creditRevenue = creditOrds.length * (avgCreditValue || Number(menu.price || 0));
      const grossRevenue  = sinpeRevenue + cashRevenue + creditRevenue;
      const mealsSold     = dayOrders.length;
      const wastedMeals   = Math.max(0, settings.max_meals - mealsSold);
      const costPerDish   = Number(menu.cost_per_dish || 0);
      const estimatedCost = costPerDish > 0 ? mealsSold * costPerDish : null;
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
      creditMeals    += creditOrds.length;

      return {
        date,
        menuTitle: menu.title || "Sin menú",
        menuPrice: Number(menu.price || 0),
        costPerDish,
        maxMeals:          settings.max_meals,
        mealsSold, wastedMeals,
        alacarteSales:     sinpeOrders.length + cashOrders.length,
        creditRedemptions: creditOrds.length,
        sinpeRevenue:      Math.round(sinpeRevenue),
        cashRevenue:       Math.round(cashRevenue),
        creditRevenue:     Math.round(creditRevenue),
        grossRevenue:      Math.round(grossRevenue),
        estimatedCost:     estimatedCost !== null ? Math.round(estimatedCost) : null,
        estimatedProfit:   estimatedProfit !== null ? Math.round(estimatedProfit) : null,
        profitMarginPct
      };
    });

    const grossRevenue = totalSinpe + totalCash + totalCredit;
    const hasCostData  = totalCosts > 0;

    const summary = {
      grossRevenue:          Math.round(grossRevenue),
      cashRevenue:           Math.round(totalCash),
      sinpeRevenue:          Math.round(totalSinpe),
      creditRevenue:         Math.round(totalCredit),
      estimatedCosts:        hasCostData ? Math.round(totalCosts) : null,
      estimatedProfit:       hasCostData ? Math.round(grossRevenue - totalCosts) : null,
      profitMarginPct:       hasCostData && grossRevenue > 0
                               ? Math.round(((grossRevenue - totalCosts) / grossRevenue) * 100) : null,
      totalMealsSold,
      alacarteMeals,
      creditMeals,
      totalWastedMeals:      totalWaste,
      avgCreditValuePerMeal: Math.round(avgCreditValue)
    };

    const csv      = buildCsv(m, summary, daily);
    const filename = `rentabilidad-${m}.csv`;

    res.setHeader("Content-Type",        "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.status(200).send(csv);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ ok: false, message: error.message });
    return res.status(500).json({ ok: false, message: error.message || "No fue posible exportar el reporte." });
  }
}
