const {
  DEVICE_LIMIT,
  PLAN_TITLE,
  rateLimit,
  getUser,
  saveUser,
  getDevice,
  saveDevice,
  computeTrialDaysRemaining,
  createJwt
} = require("./_shared");

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

    const emailRaw = body?.email || "";
    const deviceId = body?.device_id || "";

    const email = emailRaw.trim().toLowerCase();
    if (!email || !deviceId) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "invalid_request" }));
      return;
    }

    // Enforce one trial per device: if this device has already been used
    // with a different email, do not allow starting a new trial.
    const existingDeviceRecord = await getDevice(deviceId);
    if (existingDeviceRecord && existingDeviceRecord.email !== email) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "device_trial_used" }));
      return;
    }

    let user = await getUser(email);
    const nowIso = new Date().toISOString();

    if (!user) {
      user = {
        email,
        devices: [{ id: deviceId, first_seen_at: nowIso }],
        trial_started_at: nowIso,
        subscription_status: "trial",
        subscription_id: null,
        plan_title: PLAN_TITLE,
        last_payment_at: null
      };

      // First time this device is seen and first trial for this email.
      await saveDevice({ id: deviceId, email, first_seen_at: nowIso });
    } else {
      if (!Array.isArray(user.devices)) {
        user.devices = [];
      }

      const existingDevice = user.devices.find((d) => d.id === deviceId);
      if (!existingDevice) {
        if (user.devices.length >= DEVICE_LIMIT) {
          res.statusCode = 403;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "device_limit_exceeded", devices_count: DEVICE_LIMIT }));
          return;
        }
        user.devices.push({ id: deviceId, first_seen_at: nowIso });

        // New device being associated with this email; record it.
        await saveDevice({ id: deviceId, email, first_seen_at: nowIso });
      }

      if (!user.trial_started_at && (!user.subscription_status || user.subscription_status === "none")) {
        user.trial_started_at = nowIso;
        user.subscription_status = "trial";
      }
    }

    await saveUser(user);

    const { token } = createJwt(email);
    const trial_days_remaining = computeTrialDaysRemaining(user.trial_started_at);
    const subscription_status = user.subscription_status || "none";

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        token,
        trial_started_at: user.trial_started_at,
        trial_days_remaining,
        subscription_status
      })
    );
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "internal_error" }));
  }
};


