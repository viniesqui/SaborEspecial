export function setCors(res) {
  // In production, set CORS_ORIGIN to your exact frontend domain.
  // The wildcard is kept as a safe default for local development only.
  const origin = process.env.CORS_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin",  origin);
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
