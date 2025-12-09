const { kv } = require("@vercel/kv");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const adminToken = process.env.DEBUG_ADMIN_TOKEN;
  const providedToken =
    req.headers["x-debug-token"] || req.headers["X-Debug-Token"] || "";

  if (!adminToken || providedToken !== adminToken) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "forbidden" }));
    return;
  }

  try {
    const keys = await kv.keys("user:*");
    const users = [];
    for (const key of keys) {
      const user = await kv.get(key);
      users.push({ key, user });
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ users }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "internal_error" }));
  }
};


