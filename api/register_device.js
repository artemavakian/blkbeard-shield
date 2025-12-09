const { DEVICE_LIMIT, rateLimit, getUser, saveUser, verifyJwt } = require("./_shared");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // TODO: restrict in production
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  if (rateLimit(req, res)) return;

  try {
    let body = req.body;
    if (typeof body === "string") {
      body = JSON.parse(body || "{}");
    }

    const token = body?.token;
    const deviceId = body?.device_id;

    if (!token || !deviceId) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "invalid_request" }));
      return;
    }

    let payload;
    try {
      payload = verifyJwt(token);
    } catch (e) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }

    const email = payload.email?.toLowerCase();
    if (!email) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "invalid_token" }));
      return;
    }

    let user = await getUser(email);
    if (!user) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "user_not_found" }));
      return;
    }

    if (!Array.isArray(user.devices)) {
      user.devices = [];
    }

    const nowIso = new Date().toISOString();
    const existingDevice = user.devices.find((d) => d.id === deviceId);
    if (!existingDevice) {
      if (user.devices.length >= DEVICE_LIMIT) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "device_limit_exceeded", devices_count: DEVICE_LIMIT }));
        return;
      }
      user.devices.push({ id: deviceId, first_seen_at: nowIso });
    }

    await saveUser(user);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, devices_count: user.devices.length }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "internal_error" }));
  }
};


