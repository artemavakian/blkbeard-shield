import {
  ALL_SPAM_KEYWORDS
} from "./filters.js";

// Substrings that indicate affiliate / tracking / campaign parameters.
const AFFILIATE_PARAM_SUBSTRINGS = [
  "affid=",
  "affiliate=",
  "aff=",
  "referral=",
  "refid=",
  "btag=",
  "psid=",
  "campaign=",
  "cid=",
  "tid=",
  "trk=",
  "tracking=",
  "__trctx=",
  "partner=",
  "offer=",
  "landing=",

  // Additional common affiliate / tracking style parameters
  "irad=",
  "irmp=",
  "subid=",
  "subid1=",
  "partnerpropertyid="
];

function normalizeToLower(value) {
  if (!value) return "";
  return String(value).toLowerCase();
}

// Efficient substring search: convert once to lowercase and then use indexOf.
export function includesAnySubstring(haystack, keywords) {
  if (!haystack) return false;
  const text = normalizeToLower(haystack);
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (text.indexOf(keyword) !== -1) {
      return true;
    }
  }
  return false;
}

export function matchesSpamWordlists(fields) {
  const { url, title, metaDescription, textContent } = fields || {};
  const candidates = [url, title, metaDescription, textContent];

  for (const field of candidates) {
    if (!field) continue;
    if (includesAnySubstring(field, ALL_SPAM_KEYWORDS)) {
      return true;
    }
  }

  return false;
}

export function urlHasAffiliateParams(url) {
  if (!url) return false;
  return includesAnySubstring(url, AFFILIATE_PARAM_SUBSTRINGS);
}


