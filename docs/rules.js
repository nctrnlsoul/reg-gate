// GENERATED from reg-gate-workflow/rules.ts by build-page.ts. Do not edit.
// The same classifier every Chainlink DON node runs, loaded by the status page
// to explain each status. Rebuild with: bun run build:page (in reg-gate-workflow/)
// rules.ts
var CATEGORIES = [
  "STABLECOINS",
  "TOKENIZED_SECURITIES",
  "DIGITAL_ASSET_MARKETS",
  "AML_SANCTIONS"
];
var Status = { OK: 0, REVIEW: 1, BLOCK: 2 };
var STATUS_NAMES = ["OK", "REVIEW", "BLOCK"];
var WATCHED_AGENCIES = new Set([
  "securities-and-exchange-commission",
  "commodity-futures-trading-commission",
  "treasury-department",
  "comptroller-of-the-currency",
  "federal-deposit-insurance-corporation",
  "federal-reserve-system",
  "financial-crimes-enforcement-network",
  "foreign-assets-control-office",
  "consumer-financial-protection-bureau",
  "internal-revenue-service",
  "executive-office-of-the-president"
]);
var AML_AGENCIES = new Set(["financial-crimes-enforcement-network", "foreign-assets-control-office"]);
var STABLECOIN_TERMS = [/\bstablecoins?\b/, /\bgenius act\b/];
var TOKENIZED_TERMS = [
  /\btokeni[sz](ed|ation)\b/,
  /\bcrypto asset investment contracts?\b/,
  /\bsecurity tokens?\b/,
  /\bdigital asset securit(y|ies)\b/
];
var SEC_ONLY_TOKENIZED_TERMS = [/\bregulation crypto\b/];
var SEC = "securities-and-exchange-commission";
var DIGITAL_ASSET_TERMS = [
  /\bdigital assets?\b/,
  /\bcrypto\b/,
  /\bcrypto[- ]assets?\b/,
  /\bcryptocurrenc(y|ies)\b/,
  /\bvirtual currenc(y|ies)\b/,
  /\bbitcoin\b/,
  /\bblockchain\b/,
  /\bdistributed ledger\b/,
  /\bdecentralized finance\b/,
  /\bdefi\b/
];
var AML_TERMS = [
  /\bmoney laundering\b/,
  /\banti-money laundering\b/,
  /\bbank secrecy act\b/,
  /\bsanction(s|ed)?\b/,
  /\bmixers?\b/,
  /\bmixing\b/,
  /\bterrorist financing\b/
];
var PROCEDURAL_TITLES = [/^agenda$/, /\bunified agenda\b/, /\bregulatory agenda\b/, /^sunshine act meetings?\b/];
var SEARCH_TERM = 'stablecoin | stablecoins | "digital asset" | "digital assets" | crypto | cryptocurrency | "virtual currency" | bitcoin | tokenized | tokenization | blockchain | "distributed ledger"';
var FIELDS = [
  "document_number",
  "title",
  "type",
  "publication_date",
  "effective_on",
  "abstract",
  "agencies"
];
var SRO_TITLE = /^self-regulatory organizations;/;
var WITHDRAWAL_TITLE = /;\s*withdrawal\.?$/;
var anyMatch = (patterns, text) => patterns.some((p) => p.test(text));
var isNonEmptyString = (v) => typeof v === "string" && v.length > 0;
var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseFederalRegisterResponse(body) {
  let raw;
  try {
    raw = JSON.parse(body);
  } catch {
    throw new Error("FR response is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("FR response is not a JSON object");
  }
  const obj = raw;
  if (typeof obj.count !== "number" || !Number.isInteger(obj.count) || obj.count < 0) {
    throw new Error("FR response has no valid count");
  }
  if (obj.results === undefined) {
    if (obj.count !== 0)
      throw new Error("FR response missing results with nonzero count");
    return { count: 0, documents: [] };
  }
  if (!Array.isArray(obj.results))
    throw new Error("FR results is not an array");
  const documents = obj.results.map((item, i) => {
    if (typeof item !== "object" || item === null)
      throw new Error(`FR result ${i} is not an object`);
    const r = item;
    if (!isNonEmptyString(r.document_number))
      throw new Error(`FR result ${i} missing document_number`);
    if (!isNonEmptyString(r.title))
      throw new Error(`FR result ${i} missing title`);
    if (!isNonEmptyString(r.type))
      throw new Error(`FR result ${i} missing type`);
    if (!isNonEmptyString(r.publication_date) || !DATE_RE.test(r.publication_date)) {
      throw new Error(`FR result ${i} has bad publication_date`);
    }
    const eff = r.effective_on;
    if (eff !== null && eff !== undefined && eff !== "" && (typeof eff !== "string" || !DATE_RE.test(eff))) {
      throw new Error(`FR result ${i} has bad effective_on`);
    }
    if (r.abstract !== null && r.abstract !== undefined && typeof r.abstract !== "string") {
      throw new Error(`FR result ${i} has bad abstract`);
    }
    if (!Array.isArray(r.agencies))
      throw new Error(`FR result ${i} missing agencies`);
    const agencySlugs = r.agencies.map((a, j) => {
      if (typeof a !== "object" || a === null)
        throw new Error(`FR result ${i} agency ${j} is not an object`);
      const slug = a.slug;
      return typeof slug === "string" ? slug : "";
    });
    return {
      documentNumber: r.document_number,
      title: r.title,
      type: r.type,
      publicationDate: r.publication_date,
      effectiveOn: typeof eff === "string" ? eff : "",
      abstract: typeof r.abstract === "string" ? r.abstract : "",
      agencySlugs
    };
  });
  return { count: obj.count, documents };
}
function severityForType(type) {
  switch (type.trim().toLowerCase()) {
    case "rule":
    case "presidential document":
      return Status.BLOCK;
    case "proposed rule":
    case "notice":
      return Status.REVIEW;
    default:
      return Status.BLOCK;
  }
}
var normType = (doc) => doc.type.trim().toLowerCase();
function severityFor(doc, asOfDate) {
  if (normType(doc) === "rule" && doc.effectiveOn !== "" && doc.effectiveOn > asOfDate)
    return Status.REVIEW;
  return severityForType(doc.type);
}
function informationalReason(doc) {
  const title = doc.title.trim().toLowerCase();
  const type = normType(doc);
  if (type === "notice" && doc.agencySlugs.length > 0 && doc.agencySlugs.every((s) => s === SEC) && SRO_TITLE.test(title)) {
    return "sro-filing";
  }
  if (type === "proposed rule" && WITHDRAWAL_TITLE.test(title))
    return "withdrawn-proposal";
  return null;
}
function categoriesFor(doc) {
  const text = `${doc.title} ${doc.abstract}`.toLowerCase();
  const isStablecoin = anyMatch(STABLECOIN_TERMS, text);
  const isTokenized = anyMatch(TOKENIZED_TERMS, text) || doc.agencySlugs.includes(SEC) && anyMatch(SEC_ONLY_TOKENIZED_TERMS, text);
  const isDigitalAsset = anyMatch(DIGITAL_ASSET_TERMS, text) || isStablecoin || isTokenized;
  const out = [];
  if (isStablecoin)
    out.push("STABLECOINS");
  if (isTokenized)
    out.push("TOKENIZED_SECURITIES");
  if (anyMatch(DIGITAL_ASSET_TERMS, text))
    out.push("DIGITAL_ASSET_MARKETS");
  const amlAgency = doc.agencySlugs.some((s) => AML_AGENCIES.has(s));
  if (isDigitalAsset && (amlAgency || anyMatch(AML_TERMS, text)))
    out.push("AML_SANCTIONS");
  return out;
}
function isOutOfScope(doc) {
  if (doc.agencySlugs.length === 0)
    return false;
  if (doc.agencySlugs.some((s) => s === ""))
    return false;
  return !doc.agencySlugs.some((s) => WATCHED_AGENCIES.has(s));
}
function isProcedural(doc) {
  const title = doc.title.trim().toLowerCase();
  return PROCEDURAL_TITLES.some((p) => p.test(title));
}
function firstMatch(patterns, doc) {
  const title = doc.title.toLowerCase();
  const text = `${title} ${doc.abstract.toLowerCase()}`;
  for (const p of patterns) {
    const m = new RegExp(p.source, p.flags.replace("g", "")).exec(text);
    if (m)
      return { term: m[0], field: m.index < title.length ? "title" : "abstract" };
  }
  return null;
}
function severityReasonFor(doc, asOfDate) {
  const type = normType(doc);
  if (type === "rule") {
    if (doc.effectiveOn === "")
      return "final rule with no effective date, treated as in effect";
    if (doc.effectiveOn > asOfDate)
      return `final rule, takes effect ${doc.effectiveOn}`;
    return `final rule, in effect since ${doc.effectiveOn}`;
  }
  if (type === "presidential document")
    return "presidential document";
  if (type === "proposed rule")
    return "proposed rule";
  if (type === "notice")
    return "notice";
  return `unrecognized document type "${doc.type}", fails closed`;
}
function explain(doc, asOfDate) {
  const agencies = doc.agencySlugs.map((slug) => ({ slug, watched: WATCHED_AGENCIES.has(slug) }));
  const base = {
    documentNumber: doc.documentNumber,
    agencies,
    evidence: [],
    categories: [],
    informational: null,
    severity: null,
    severityReason: severityReasonFor(doc, asOfDate)
  };
  if (isOutOfScope(doc))
    return { ...base, outcome: "out-of-scope" };
  if (isProcedural(doc))
    return { ...base, outcome: "procedural" };
  const evidence = [];
  const stable = firstMatch(STABLECOIN_TERMS, doc);
  if (stable)
    evidence.push({ category: "STABLECOINS", ...stable });
  const tok = firstMatch(TOKENIZED_TERMS, doc);
  const secOnly = doc.agencySlugs.includes(SEC) ? firstMatch(SEC_ONLY_TOKENIZED_TERMS, doc) : null;
  if (tok)
    evidence.push({ category: "TOKENIZED_SECURITIES", ...tok });
  else if (secOnly)
    evidence.push({ category: "TOKENIZED_SECURITIES", ...secOnly, note: "counts only from the SEC" });
  const digital = firstMatch(DIGITAL_ASSET_TERMS, doc);
  if (digital)
    evidence.push({ category: "DIGITAL_ASSET_MARKETS", ...digital });
  if (stable || tok || secOnly || digital) {
    const amlAgency = doc.agencySlugs.find((s) => AML_AGENCIES.has(s));
    const amlTerm = firstMatch(AML_TERMS, doc);
    if (amlAgency) {
      evidence.push({ category: "AML_SANCTIONS", term: amlAgency, field: "agency", note: "an AML agency on a digital asset document" });
    } else if (amlTerm) {
      evidence.push({ category: "AML_SANCTIONS", ...amlTerm, note: "on a digital asset document" });
    }
  }
  const categories = CATEGORIES.filter((c) => evidence.some((e) => e.category === c));
  if (categories.length === 0)
    return { ...base, outcome: "no-match" };
  const info = informationalReason(doc);
  if (info !== null)
    return { ...base, outcome: "informational", evidence, categories, informational: info };
  return { ...base, outcome: "matched", evidence, categories, severity: severityFor(doc, asOfDate) };
}
var moreRecent = (a, b) => a.publicationDate !== b.publicationDate ? a.publicationDate > b.publicationDate : a.documentNumber > b.documentNumber;
var EMPTY = { count: 0, documents: [] };
function classify(published, windowStart, windowEnd, takingEffect = EMPTY) {
  const statuses = CATEGORIES.map(() => Status.OK);
  const triggers = CATEGORIES.map(() => null);
  let matched = 0;
  let ignored = 0;
  let informational = 0;
  for (const doc of published.documents) {
    if (doc.publicationDate < windowStart || doc.publicationDate > windowEnd) {
      throw new Error(`FR document ${doc.documentNumber} outside requested window`);
    }
  }
  for (const doc of takingEffect.documents) {
    if (normType(doc) !== "rule") {
      throw new Error(`FR document ${doc.documentNumber} from the effective-date query is not a final rule`);
    }
    if (doc.effectiveOn === "" || doc.effectiveOn < windowStart || doc.effectiveOn > windowEnd) {
      throw new Error(`FR document ${doc.documentNumber} does not take effect in the requested window`);
    }
  }
  const seen = new Set;
  const docs = [];
  for (const doc of [...published.documents, ...takingEffect.documents]) {
    if (seen.has(doc.documentNumber))
      continue;
    seen.add(doc.documentNumber);
    docs.push(doc);
  }
  for (const doc of docs) {
    if (isOutOfScope(doc) || isProcedural(doc)) {
      ignored++;
      continue;
    }
    const cats = categoriesFor(doc);
    if (cats.length === 0) {
      ignored++;
      continue;
    }
    if (informationalReason(doc) !== null) {
      informational++;
      continue;
    }
    matched++;
    const sev = severityFor(doc, windowEnd);
    for (const cat of cats) {
      const i = CATEGORIES.indexOf(cat);
      const current = triggers[i];
      if (sev > statuses[i] || sev === statuses[i] && current !== null && moreRecent(doc, current)) {
        statuses[i] = sev;
        triggers[i] = doc;
      }
    }
  }
  const truncated = published.count > published.documents.length || takingEffect.count > takingEffect.documents.length;
  if (truncated) {
    for (let i = 0;i < statuses.length; i++) {
      if (statuses[i] < Status.REVIEW)
        statuses[i] = Status.REVIEW;
    }
  }
  return {
    windowStart,
    windowEnd,
    statuses,
    triggerDocs: triggers.map((d) => d ? d.documentNumber : ""),
    matched,
    ignored,
    informational,
    truncated
  };
}
var DAY_MS = 86400000;
var isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
function computeWindow(scheduledUnixSeconds, lookbackDays) {
  if (!Number.isInteger(scheduledUnixSeconds) || scheduledUnixSeconds <= 0) {
    throw new Error("scheduled time must be a positive integer");
  }
  if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 90) {
    throw new Error("lookbackDays must be an integer from 1 to 90");
  }
  const dayStart = Math.floor(scheduledUnixSeconds * 1000 / DAY_MS) * DAY_MS;
  const endMs = dayStart - DAY_MS;
  return { start: isoDate(endMs - (lookbackDays - 1) * DAY_MS), end: isoDate(endMs) };
}
function queryUrl(baseUrl, perPage, conditions) {
  if (!baseUrl.startsWith("https://"))
    throw new Error("FR base URL must be https");
  const enc = encodeURIComponent;
  const parts = [
    `per_page=${perPage}`,
    "order=newest",
    ...FIELDS.map((f) => `${enc("fields[]")}=${f}`),
    `${enc("conditions[term]")}=${enc(SEARCH_TERM)}`,
    ...conditions
  ];
  return `${baseUrl}?${parts.join("&")}`;
}
function buildQueryUrl(baseUrl, window, perPage) {
  const enc = encodeURIComponent;
  return queryUrl(baseUrl, perPage, [
    `${enc("conditions[publication_date][gte]")}=${window.start}`,
    `${enc("conditions[publication_date][lte]")}=${window.end}`
  ]);
}
function buildEffectiveQueryUrl(baseUrl, window, perPage) {
  const enc = encodeURIComponent;
  return queryUrl(baseUrl, perPage, [
    `${enc("conditions[type][]")}=RULE`,
    `${enc("conditions[effective_date][gte]")}=${window.start}`,
    `${enc("conditions[effective_date][lte]")}=${window.end}`
  ]);
}
function serializeResult(r) {
  return JSON.stringify({
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    statuses: r.statuses,
    triggerDocs: r.triggerDocs,
    matched: r.matched,
    ignored: r.ignored,
    informational: r.informational,
    truncated: r.truncated
  });
}
function deserializeResult(s) {
  const r = JSON.parse(s);
  if (!Array.isArray(r.statuses) || r.statuses.length !== CATEGORIES.length)
    throw new Error("bad statuses");
  if (!r.statuses.every((x) => x === 0 || x === 1 || x === 2))
    throw new Error("bad status value");
  if (!Array.isArray(r.triggerDocs) || r.triggerDocs.length !== CATEGORIES.length)
    throw new Error("bad triggerDocs");
  for (const k of ["matched", "ignored", "informational"]) {
    if (!Number.isInteger(r[k]) || r[k] < 0)
      throw new Error(`bad ${k}`);
  }
  return r;
}
function summarize(r) {
  const lines = CATEGORIES.map((c, i) => `${c}=${STATUS_NAMES[r.statuses[i]]}${r.triggerDocs[i] ? ` (${r.triggerDocs[i]})` : ""}`);
  return `window ${r.windowStart}..${r.windowEnd} matched=${r.matched} ignored=${r.ignored} informational=${r.informational} truncated=${r.truncated} | ${lines.join(" ")}`;
}
export {
  CATEGORIES,
  FIELDS,
  SEARCH_TERM,
  STATUS_NAMES,
  Status,
  WATCHED_AGENCIES,
  buildEffectiveQueryUrl,
  buildQueryUrl,
  categoriesFor,
  classify,
  computeWindow,
  deserializeResult,
  explain,
  informationalReason,
  isOutOfScope,
  isProcedural,
  parseFederalRegisterResponse,
  serializeResult,
  severityFor,
  severityForType,
  summarize
};
