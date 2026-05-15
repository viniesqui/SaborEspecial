// DEPRECATED — WS-07 R-07-2.
// This endpoint is superseded by /api/dashboard:
//   GET  /api/menu        →  GET  /api/dashboard?include=menu
//   POST /api/menu        →  POST /api/dashboard
// Retained as a thin proxy for one deploy cycle so older client builds
// keep working during rollout. Remove next sprint once no traffic reaches it.
// See docs/API.md for the canonical contract.

import dashboardHandler from "./dashboard.js";

export default function handler(req, res) {
  if (req.method === "GET") {
    req.query = Object.assign({}, req.query, { include: "menu" });
  }
  return dashboardHandler(req, res);
}
