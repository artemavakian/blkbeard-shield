// Vercel serverless function to record spam reports in Supabase.
// Endpoint: https://api.blkbeard.ai/api/report-spam
//
// Expects a JSON POST body:
// {
//   domain: string,
//   url: string,
//   timestamp: number | string,
//   userId: string | null
// }

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({ error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured" })
    );
    return;
  }

  try {
    const { domain, url, timestamp, userId } = req.body || {};

    if (!domain || !url) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Missing domain or url" }));
      return;
    }

    const safeDomain = String(domain).slice(0, 255);
    const safeUrl = String(url).slice(0, 2000);
    const safeUserId = userId ? String(userId).slice(0, 255) : null;
    const safeTimestamp =
      typeof timestamp === "number" || typeof timestamp === "string"
        ? timestamp
        : Date.now();

    const response = await fetch(`${supabaseUrl}/rest/v1/spam_reports`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        Prefer: "return=minimal"
      },
      body: JSON.stringify([
        {
          domain: safeDomain,
          url: safeUrl,
          timestamp: safeTimestamp,
          user_id: safeUserId
        }
      ])
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "Supabase error", detail: text }));
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
};


