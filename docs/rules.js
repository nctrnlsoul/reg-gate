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
  "executive-office-of-the-president",
  "national-credit-union-administration"
]);
var AML_AGENCIES = new Set(["financial-crimes-enforcement-network", "foreign-assets-control-office"]);
var STABLECOIN_TERMS = [/\bstable[\s-]?coins?\b/, /\bgenius act\b/];
var TOKENIZED_TERMS = [
  /\btokeni[sz](e|es|ed|ing|ation|ations)\b/,
  /\bcrypto[\s-]?asset investment contracts?\b/,
  /\bsecurity tokens?\b/,
  /\bdigital[\s-]+asset securit(y|ies)\b/
];
var SEC_ONLY_TOKENIZED_TERMS = [/\bregulation crypto\b/];
var SEC = "securities-and-exchange-commission";
var DIGITAL_ASSET_TERMS = [
  /\bdigital[\s-]+assets?\b/,
  /\bcrypto\b/,
  /\bcrypto[\s-]?assets?\b/,
  /\bcrypto[\s-]?currenc(y|ies)\b/,
  /\bvirtual[\s-]+currenc(y|ies)\b/,
  /\bvirtual[\s-]+assets?\b/,
  /\bbitcoin\b/,
  /\bblock[\s-]?chains?\b/,
  /\bdistributed[\s-]+ledgers?\b/,
  /\bdecentralized[\s-]+finance\b/,
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
var SEARCH_TERM = 'stablecoin | stablecoins | "stable coin" | "digital asset" | "digital assets" | crypto | cryptocurrency | "crypto asset" | "crypto assets" | "virtual currency" | "virtual asset" | "virtual assets" | bitcoin | tokenized | tokenization | tokenizing | blockchain | "distributed ledger"';
var FIELDS = [
  "document_number",
  "title",
  "type",
  "publication_date",
  "effective_on",
  "abstract",
  "excerpts",
  "agencies"
];
var SRO_TITLE = /^self-regulatory organizations;/;
var WITHDRAWAL_TITLE = /;\s*withdrawal\.?$/;
var FINRA = /\bfinancial industry regulatory authority\b|\bmunicipal securities rulemaking board\b/;
var SRO_IN_FORCE = /\border (approving|granting)\b|\bimmediate effectiveness\b|\beffective upon filing\b/;
var RELIEF = /\bexempt(ion|ions|ive)?\b|\brelief\b|\bsafe harbors?\b/;
var MAX_BLOCK_DOCS = 16;
var INCOMPLETE_PREFIX = "INCOMPLETE-";
var EFFECTIVE_HORIZON_DAYS = 366;
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
    return { count: 0, documents: [], duplicates: 0 };
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
    if (r.excerpts !== null && r.excerpts !== undefined && typeof r.excerpts !== "string") {
      throw new Error(`FR result ${i} has bad excerpts`);
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
      excerpts: typeof r.excerpts === "string" ? cleanExcerpt(r.excerpts) : "",
      agencySlugs
    };
  });
  const seen = new Set;
  const unique = [];
  let duplicates = 0;
  for (const d of documents) {
    if (seen.has(d.documentNumber))
      duplicates++;
    else {
      seen.add(d.documentNumber);
      unique.push(d);
    }
  }
  return { count: obj.count, documents: unique, duplicates };
}
function cleanExcerpt(s) {
  return s.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
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
  if (type === "notice" && doc.agencySlugs.length > 0 && doc.agencySlugs.every((s) => s === SEC) && SRO_TITLE.test(title) && !FINRA.test(title) && !SRO_IN_FORCE.test(title) && !anyMatch(TOKENIZED_TERMS, `${title} ${doc.abstract} ${doc.excerpts}`.toLowerCase()) && !anyMatch(SEC_ONLY_TOKENIZED_TERMS, `${title} ${doc.abstract} ${doc.excerpts}`.toLowerCase())) {
    return "sro-filing";
  }
  if (type === "proposed rule" && WITHDRAWAL_TITLE.test(title) && !RELIEF.test(title))
    return "withdrawn-proposal";
  return null;
}
function categoriesFor(doc) {
  const text = `${doc.title} ${doc.abstract} ${doc.excerpts}`.toLowerCase();
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
  const abstract = doc.abstract.toLowerCase();
  const text = `${title} ${abstract} ${doc.excerpts.toLowerCase()}`;
  for (const p of patterns) {
    const m = new RegExp(p.source, p.flags.replace("g", "")).exec(text);
    if (m)
      return { term: m[0], field: m.index < title.length ? "title" : m.index <= title.length + abstract.length ? "abstract" : "excerpt" };
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
function eventDate(doc, asOfDate) {
  if (normType(doc) === "rule" && doc.effectiveOn !== "" && doc.effectiveOn <= asOfDate && doc.effectiveOn > doc.publicationDate) {
    return doc.effectiveOn;
  }
  return doc.publicationDate;
}
var moreRecent = (a, b, asOfDate) => {
  const ea = eventDate(a, asOfDate);
  const eb = eventDate(b, asOfDate);
  return ea !== eb ? ea > eb : a.documentNumber > b.documentNumber;
};
var EMPTY = { count: 0, documents: [], duplicates: 0 };
function classify(published, windowStart, windowEnd, takingEffect = EMPTY, asOfDate = windowEnd, horizon = asOfDate) {
  const statuses = CATEGORIES.map(() => Status.OK);
  const triggers = CATEGORIES.map(() => null);
  const blocking = CATEGORIES.map(() => []);
  const placeholderTrigger = CATEGORIES.map(() => "");
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
    if (doc.effectiveOn === "" || doc.effectiveOn < windowStart || doc.effectiveOn > horizon) {
      throw new Error(`FR document ${doc.documentNumber} does not take effect in the requested window`);
    }
    if (doc.publicationDate > windowEnd) {
      throw new Error(`FR document ${doc.documentNumber} from the effective-date query was published after the window`);
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
    const sev = severityFor(doc, asOfDate);
    for (const cat of cats) {
      const i = CATEGORIES.indexOf(cat);
      const current = triggers[i];
      if (sev > statuses[i] || sev === statuses[i] && current !== null && moreRecent(doc, current, asOfDate)) {
        statuses[i] = sev;
        triggers[i] = doc;
      }
      if (sev === Status.BLOCK)
        blocking[i].push(doc);
    }
  }
  const blockDocs = blocking.map((list) => list.slice().sort((a, b) => moreRecent(a, b, asOfDate) ? -1 : moreRecent(b, a, asOfDate) ? 1 : 0).map((d) => d.documentNumber));
  const faulty = (r) => r.count !== r.documents.length || r.duplicates > 0;
  const truncated = faulty(published) || faulty(takingEffect);
  const incomplete = CATEGORIES.map(() => truncated);
  const size = () => blockDocs.reduce((n, l, i) => n + l.length + (incomplete[i] ? 1 : 0), 0);
  while (size() > MAX_BLOCK_DOCS) {
    let c = 0;
    for (let i = 1;i < blockDocs.length; i++)
      if (blockDocs[i].length > blockDocs[c].length)
        c = i;
    incomplete[c] = true;
    blockDocs[c].pop();
  }
  const overflow = !truncated && incomplete.some(Boolean);
  const placeholder = INCOMPLETE_PREFIX + asOfDate;
  incomplete.forEach((on, i) => {
    if (!on)
      return;
    statuses[i] = Status.BLOCK;
    blockDocs[i].unshift(placeholder);
    if (!triggers[i])
      placeholderTrigger[i] = placeholder;
  });
  return {
    windowStart,
    windowEnd,
    asOfDate,
    statuses,
    triggerDocs: triggers.map((d, i) => d ? d.documentNumber : placeholderTrigger[i]),
    blockDocs,
    matched,
    ignored,
    informational,
    truncated,
    overflow
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
  return {
    start: isoDate(endMs - (lookbackDays - 1) * DAY_MS),
    end: isoDate(endMs),
    today: isoDate(dayStart),
    horizon: isoDate(dayStart + EFFECTIVE_HORIZON_DAYS * DAY_MS)
  };
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
    `${enc("conditions[effective_date][lte]")}=${window.horizon}`,
    `${enc("conditions[publication_date][lte]")}=${window.end}`
  ]);
}
function serializeResult(r) {
  return JSON.stringify({
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    asOfDate: r.asOfDate,
    statuses: r.statuses,
    triggerDocs: r.triggerDocs,
    blockDocs: r.blockDocs,
    matched: r.matched,
    ignored: r.ignored,
    informational: r.informational,
    truncated: r.truncated,
    overflow: r.overflow
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
  if (!Array.isArray(r.blockDocs) || r.blockDocs.length !== CATEGORIES.length)
    throw new Error("bad blockDocs");
  let total = 0;
  r.blockDocs.forEach((list, i) => {
    if (!Array.isArray(list) || !list.every((d) => typeof d === "string" && d.length > 0 && d.length <= 32)) {
      throw new Error("bad blockDocs entry");
    }
    if (list.length > 0 && r.statuses[i] !== Status.BLOCK)
      throw new Error("blockDocs on a category not at BLOCK");
    total += list.length;
  });
  if (total > MAX_BLOCK_DOCS)
    throw new Error("too many blockDocs");
  if (typeof r.truncated !== "boolean" || typeof r.overflow !== "boolean")
    throw new Error("bad completeness flags");
  return r;
}
function summarize(r) {
  const lines = CATEGORIES.map((c, i) => `${c}=${STATUS_NAMES[r.statuses[i]]}${r.triggerDocs[i] ? ` (${r.triggerDocs[i]})` : ""}`);
  const blocking = r.blockDocs.reduce((n, l) => n + l.length, 0);
  return `window ${r.windowStart}..${r.windowEnd} asOf=${r.asOfDate} blocking=${blocking} matched=${r.matched} ignored=${r.ignored} informational=${r.informational} truncated=${r.truncated} overflow=${r.overflow} | ${lines.join(" ")}`;
}
export {
  CATEGORIES,
  EFFECTIVE_HORIZON_DAYS,
  FIELDS,
  INCOMPLETE_PREFIX,
  MAX_BLOCK_DOCS,
  SEARCH_TERM,
  STATUS_NAMES,
  Status,
  WATCHED_AGENCIES,
  buildEffectiveQueryUrl,
  buildQueryUrl,
  categoriesFor,
  classify,
  cleanExcerpt,
  computeWindow,
  deserializeResult,
  eventDate,
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
