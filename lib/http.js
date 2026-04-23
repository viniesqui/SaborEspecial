export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

export function handleOptions(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.status(200).end();
    return true;
  }

  return false;
}
