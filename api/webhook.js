const crypto = require("crypto");
const { PLAN_TITLE, getUser, saveUser } = require("./_shared");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const secret = process.env.FREEMIUS_SECRET_KEY;
  if (!secret) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "freemius_secret_not_configured" }));
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};

    // Freemius docs define exactly how to compute the signature. Here we assume:
    // header: 'x-freemius-signature', algorithm: HMAC-SHA256 over the raw JSON body.
    const signatureHeader =
      req.headers["x-freemius-signature"] || req.headers["X-Freemius-Signature"];
    const payloadString = JSON.stringify(body);
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payloadString)
      .digest("hex");

    if (!signatureHeader || signatureHeader !== expectedSignature) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "invalid_signature" }));
      return;
    }

    const event =
      body.event || body.type || body.event_type || body.action || "unknown_event";

    const email =
      body.user?.email ||
      body.customer_email ||
      body.payer_email ||
      body.email ||
      null;

    if (!email) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "missing_email" }));
      return;
    }

    const emailLower = email.toLowerCase();
    let user = (await getUser(emailLower)) || {
      email: emailLower,
      devices: [],
      trial_started_at: null,
      subscription_status: "none",
      subscription_id: null,
      plan_title: PLAN_TITLE,
      last_payment_at: null
    };

    const nowIso = new Date().toISOString();

    if (
      event === "subscription_created" ||
      event === "subscription_renewed" ||
      event === "payment_succeeded" ||
      event === "recurring_payment_succeeded"
    ) {
      user.subscription_status = "active";
      user.subscription_id =
        body.subscription_id || body.subscription?.id || user.subscription_id || null;
      user.plan_title = PLAN_TITLE;
      user.last_payment_at =
        body.created_at || body.paid_at || body.updated_at || nowIso;
    } else if (event === "subscription_cancelled") {
      user.subscription_status = "cancelled";
    } else if (event === "trial_started") {
      user.trial_started_at =
        body.trial_started_at || body.created_at || body.timestamp || nowIso;
      if (!user.subscription_status || user.subscription_status === "none") {
        user.subscription_status = "trial";
      }
    }

    await saveUser(user);

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "internal_error" }));
  }
};


