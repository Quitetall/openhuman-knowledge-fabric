// The decisions the DRBench fixture makes: which fictional company is which KF organization, its
// people and what each may read, and how every file is classified. The README reproduces the
// tables; change them together.
//
// DRBench (ServiceNow, Apache-2.0) writes each of its 100 deep-research tasks for ONE of three
// fictional companies, each with its own profile, personas, mail domain and files. They are three
// companies, not one company's departments, so each is loaded as its own KF organization.

export const CORPUS = 'drbench';
export const KEY_PREFIX = 'drb-v1';

/** Company name as DRBench writes it (before any " (city, revenue, size)" suffix) → organization. */
export const COMPANIES = {
  "Lee's Market": {
    slug: 'lees-market',
    legal_name: "Lee's Market",
    structure: 'retail/lees_market.json',
    username_prefix: 'lm.',
    office: 'emily.patel',
    email_domain: 'lees-market.example',
  },
  'MediConn Solutions': {
    slug: 'mediconn',
    legal_name: 'MediConn Solutions',
    structure: 'healthcare/mediconn.json',
    username_prefix: 'mc.',
    office: 'rachel.lee',
    email_domain: 'mediconn.example',
  },
  'Elexion Automotive': {
    slug: 'elexion',
    legal_name: 'Elexion Automotive',
    structure: 'automobiles/elexion_auto.json',
    username_prefix: 'ea.',
    office: 'amanda.lee',
    email_domain: 'elexion.example',
  },
};

export function companyOf(name) {
  const base = name.split(' (')[0].trim();
  const company = COMPANIES[base];
  if (company === undefined) throw new Error(`unknown DRBench company ${name}`);
  return { name: base, ...company };
}

const RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 };
export const rank = (c) => RANK[c];
const SENIORITY = { Executive: 0, Senior: 1, Mid: 2, Junior: 3 };

/**
 * Authority by DRBench seniority. One person of each company's own DRBench roster (`office`
 * above: the most senior in contexts/company_structures, first by name) is also its records
 * office — founds the organization, ingests the estate and records the grants — and holds
 * `restricted` whatever their seniority, because an ingest may carry any classification.
 */
export const BY_SENIORITY = {
  Executive: { role: 'project_owner', clearance: 'restricted', ceiling: 'restricted' },
  Senior: { role: 'reviewer', clearance: 'confidential', ceiling: 'confidential' },
  Mid: { role: 'performer', clearance: 'confidential', ceiling: 'internal' },
  Junior: { role: 'performer', clearance: 'internal', ceiling: 'internal' },
};

export function personKey(name) {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('.');
}

/** People of one company: its DRBench personas and every task asker, once each. */
export function peopleOf(company, personas) {
  const byKey = new Map();
  for (const p of personas) {
    const key = personKey(p.name);
    if (byKey.has(key)) continue;
    byKey.set(key, { ...p, key });
  }
  const ordered = [...byKey.values()].sort(
    (a, b) =>
      (SENIORITY[a.seniority] ?? 9) - (SENIORITY[b.seniority] ?? 9) || a.key.localeCompare(b.key),
  );
  if (!byKey.has(company.office)) throw new Error(`${company.legal_name}: no ${company.office}`);
  return ordered.map((p) => {
    const a = BY_SENIORITY[p.seniority] ?? BY_SENIORITY.Mid;
    const office = p.key === company.office;
    return {
      key: p.key,
      name: p.name,
      title: p.role,
      department: p.department,
      seniority: p.seniority,
      role: a.role,
      clearance: office ? 'restricted' : a.clearance,
      ceiling: office ? 'restricted' : a.ceiling,
      ...(office ? { persona: 'records' } : {}),
      username: `${company.username_prefix}${p.key}`,
      email: `${p.key}@${company.email_domain}`,
      corpus_email: p.email,
    };
  });
}

/**
 * Classification by what a file is about: the words of its name and, for a mail or chat export,
 * its subjects, teams and channels. First match wins; the catch-all is `internal`.
 */
export const CLASSIFICATION_RULES = [
  {
    match:
      /\b(salar(y|ies)|compensation|payroll|merger|acquisition|board|litigation|lawsuit|breach)\b/,
    classification: 'restricted',
    why: 'pay, M&A, board, litigation, breaches',
  },
  {
    match:
      /\b(financials?|finance|budget|revenue|cost|costs|pricing|profit|forecast|contracts?|vendors?|patients?|hr|employees?|workforce|retention|performance|security|audit|compliance|regulatory|risk)\b/,
    classification: 'confidential',
    why: 'money, contracts, patients, people, security and compliance',
  },
  {
    match: /\b(press|newsletter|brochure|announcement|public|catalog|flyer)\b/,
    classification: 'public',
    why: 'published material',
  },
  { match: /.*/, classification: 'internal', why: 'everything else' },
];

export function classify(about) {
  const text = about.toLowerCase().replace(/[-_.]+/g, ' ');
  for (const rule of CLASSIFICATION_RULES) {
    if (rule.match.test(text)) return { classification: rule.classification, rule: rule.why };
  }
  throw new Error('unreachable');
}

/**
 * Readers by grant: the task's asker (DRBench set the task for them: every file of it is theirs
 * to read) and, for a mail, the company's people it is addressed to — each only where the file is
 * above their ceiling and within their clearance.
 */
export function readersOf(doc, people) {
  const c = rank(doc.classification);
  const candidates = new Set([...(doc.askers ?? []), ...(doc.participants ?? [])]);
  return people
    .filter((p) => candidates.has(p.key) && c > rank(p.ceiling) && c <= rank(p.clearance))
    .map((p) => p.key)
    .sort();
}

export function artifactKindOf(format, app) {
  if (app === 'email' || app === 'mattermost') return 'message_snapshot';
  if (format === 'xlsx') return 'dataset';
  return 'document';
}

/** The committed sample: every file of these tasks (one per company, each with mail or chat). */
export const SAMPLE_TASKS = ['DR0001', 'DR0006', 'DR0011'];
