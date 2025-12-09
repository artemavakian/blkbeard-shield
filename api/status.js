const { rateLimit, getUser, computeTrialDaysRemaining, verifyJwt } = require("./_shared");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*"); // TODO: restrict in production
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

  if (rateLimit(req, res)) return;

  try {
    const token = req.query?.token || req.query?.t;
    if (!token) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "missing_token" }));
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

    const user = (await getUser(email)) || {
      email,
      devices: [],
      trial_started_at: null,
      subscription_status: "none",
      subscription_id: null,
      plan_title: null,
      last_payment_at: null
    };

    const devices = Array.isArray(user.devices) ? user.devices.map((d) => d.id) : [];
    const devices_count = devices.length;
    const trial_days_remaining = computeTrialDaysRemaining(user.trial_started_at);
    const subscription_status = user.subscription_status || "none";

    const response = {
      email: user.email,
      subscription_status,
      trial_days_remaining,
      devices,
      devices_count
    };

    if (subscription_status === "active") {
      response.subscription_id = user.subscription_id || null;
      response.plan_title = user.plan_title || null;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(response));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "internal_error" }));
  }
};


