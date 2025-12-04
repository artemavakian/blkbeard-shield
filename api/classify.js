// Vercel serverless function for page classification.
// Endpoint: https://api.blkbeard.ai/api/classify
//
// Expects a JSON POST body:
// {
//   url: string,
//   title: string,
//   metaDescription: string,
//   textSnippet: string
// }
//
// Returns JSON:
// {
//   gambling: boolean,
//   adult: boolean,
//   fakeSoftware: boolean,
//   genericScam: boolean,
//   ageGate: boolean
// }

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";

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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "OPENAI_API_KEY not configured" }));
    return;
  }

  try {
    const { url, title, metaDescription, textSnippet } = req.body || {};

    const snippet = (textSnippet || "").toString().slice(0, 1000);
    const safeUrl = (url || "").toString().slice(0, 2000);
    const safeTitle = (title || "").toString().slice(0, 512);
    const safeMeta = (metaDescription || "").toString().slice(0, 512);

    const prompt = `
You are a strict content classifier that labels web pages as potentially harmful or high-risk vs benign.

Given:
- URL: "${safeUrl}"
- Title: "${safeTitle}"
- Meta description: "${safeMeta}"
- First ~1000 characters of visible text: "${snippet}"

Decide whether the page is clearly any of the following:
- gambling / casino / betting
- adult / XXX / pornographic OR sexually-oriented chat/cam services
  (examples: adult chat, sex chat, private chat, cam chat, random video chat rooms with sexual or dating intent)
- fake software / scareware / bogus utilities / fake downloads
- generic scam / prize / "you won" / misleading offer
- age/consent gate related to adult or explicit content

Respond ONLY with a single JSON object, no extra text, of the form:
{
  "gambling": boolean,
  "adult": boolean,
  "fakeSoftware": boolean,
  "genericScam": boolean,
  "ageGate": boolean
}

Be conservative: only set a flag to true if the page is clearly in that category based on the text above.
`;

    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: "You are a careful, security-focused content classifier." },
          { role: "user", content: prompt }
        ],
        temperature: 0
      })
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      res.statusCode = 502;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "OpenAI API error", detail: text }));
      return;
    }

    const data = await response.json();
    let rawContent = "";
    try {
      rawContent = data.choices?.[0]?.message?.content || "";
    } catch {
      rawContent = "";
    }

    let verdict = {
      gambling: false,
      adult: false,
      fakeSoftware: false,
      genericScam: false,
      ageGate: false
    };

    if (rawContent && typeof rawContent === "string") {
      try {
        const parsed = JSON.parse(rawContent);
        verdict = {
          gambling: !!parsed.gambling,
          adult: !!parsed.adult,
          fakeSoftware: !!parsed.fakeSoftware,
          genericScam: !!parsed.genericScam,
          ageGate: !!parsed.ageGate
        };
      } catch (e) {
        // If parsing fails, keep all flags false.
      }
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(verdict));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
};


