// The decisions the EnterpriseRAG-Bench fixture makes over the corpus: who the people are, what
// each may read, and how every document is classified. Pure functions of the corpus's own data
// (its employee directory, each document's path in the generator's source tree, a mail's
// headers), so the loader, the overlay generator and the tests all compute the same answer.
//
// The README reproduces the tables below; change them together.

export const CORPUS = 'enterprise-rag-bench';
export const KEY_PREFIX = 'erb-v1';
export const LEGAL_NAME = 'Redwood Inference, Inc.';
export const EMAIL_DOMAIN = 'redwood-inference.example';
export const USERNAME_PREFIX = 'rw.';

/** The founding grant is the CTO's: the directory has no CEO, and she heads its first tree. */
export const FOUNDER = 'ava.chen';
/** The IT systems administrator ingests the estate and records the need-to-know grants. */
export const OFFICE = 'natalie.chen';
/** The persona the search baseline asks as: reads everything, so recall measures search only. */
export const BASELINE_ASKER = 'ava.chen';

const RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 };
export const rank = (c) => RANK[c];

/**
 * Classification by the document's path in the generator's source tree (uuid_index.json).
 * First match wins; `mailbox` rules apply to gmail/<owner>/… by the owner's department.
 */
export const CLASSIFICATION_RULES = [
  {
    match: 'google_drive/shared_drives/people-ops/',
    classification: 'restricted',
    why: 'personnel files',
  },
  {
    match: 'google_drive/shared_drives/finance-and-legal/',
    classification: 'restricted',
    why: 'finance and legal drive',
  },
  { match: 'fireflies/interviews/', classification: 'restricted', why: 'candidate interviews' },
  {
    match: 'gmail/',
    mailbox: 'leadership',
    classification: 'restricted',
    why: 'mailboxes of the C-level, People, Finance and Legal',
  },
  { match: 'gmail/', classification: 'confidential', why: 'every other mailbox' },
  { match: 'hubspot/', classification: 'confidential', why: 'CRM: deals, accounts, contacts' },
  {
    match: 'fireflies/sales-calls/',
    classification: 'confidential',
    why: 'customer sales calls',
  },
  {
    match: 'fireflies/customer-success/',
    classification: 'confidential',
    why: 'customer success calls',
  },
  { match: 'fireflies/partners/', classification: 'confidential', why: 'partner negotiations' },
  {
    match: 'jira/customer-support/',
    classification: 'confidential',
    why: 'customer tickets (customer data)',
  },
  { match: 'slack/finance/', classification: 'confidential', why: 'finance channel' },
  { match: 'slack/people-ops/', classification: 'confidential', why: 'people-ops channel' },
  { match: 'slack/eng-security/', classification: 'confidential', why: 'security channel' },
  {
    match: 'confluence/finance-and-legal/',
    classification: 'confidential',
    why: 'finance and legal space',
  },
  { match: 'confluence/people-ops/', classification: 'confidential', why: 'people-ops space' },
  {
    match: 'confluence/security-and-compliance/',
    classification: 'confidential',
    why: 'security programme',
  },
  {
    match: 'confluence/sales-enablement/',
    classification: 'confidential',
    why: 'pricing, battlecards',
  },
  {
    match: 'confluence/customer-success-and-support/',
    classification: 'confidential',
    why: 'customer playbooks',
  },
  {
    match: 'google_drive/shared_drives/go-to-market/',
    classification: 'confidential',
    why: 'go-to-market drive',
  },
  {
    match: 'google_drive/shared_drives/customer-success/',
    classification: 'confidential',
    why: 'customer success drive',
  },
  {
    match: 'google_drive/shared_drives/security-and-compliance/',
    classification: 'confidential',
    why: 'security drive',
  },
  { match: 'linear/business-ops/', classification: 'confidential', why: 'business operations' },
  ...[
    'redwood-docs',
    'redwood-examples',
    'redwood-quickstarts',
    'redwood-sdk-go',
    'redwood-sdk-python',
    'redwood-sdk-typescript',
    'redwood-openai-compat',
    'redwood-helm-charts',
    'redwood-terraform',
  ].map((repo) => ({
    match: `github/${repo}/`,
    classification: 'public',
    why: 'open-source repository',
  })),
  { match: 'confluence/product-docs/', classification: 'public', why: 'published product docs' },
  { match: '', classification: 'internal', why: 'engineering, product, all-company' },
];

/** Departments whose staff's mailboxes are `restricted` (with every C-level mailbox). */
const LEADERSHIP_DEPARTMENTS = new Set(['Finance', 'People', 'Legal']);

/**
 * Need-to-know by department: the folders whose documents above a person's ceiling (and within
 * their clearance) are granted to everyone in the department.
 */
export const DEPARTMENT_FOLDERS = {
  Sales: [
    'hubspot/',
    'fireflies/sales-calls/',
    'fireflies/partners/',
    'confluence/sales-enablement/',
    'google_drive/shared_drives/go-to-market/',
  ],
  'Solutions Engineering / Professional Services': [
    'fireflies/sales-calls/',
    'jira/customer-support/',
    'confluence/customer-success-and-support/',
  ],
  'Customer Success & Support': [
    'jira/customer-support/',
    'fireflies/customer-success/',
    'confluence/customer-success-and-support/',
    'google_drive/shared_drives/customer-success/',
    'hubspot/',
  ],
  'Security & Compliance': [
    'slack/eng-security/',
    'confluence/security-and-compliance/',
    'google_drive/shared_drives/security-and-compliance/',
  ],
  Finance: [
    'slack/finance/',
    'confluence/finance-and-legal/',
    'google_drive/shared_drives/finance-and-legal/',
    'linear/business-ops/',
  ],
  People: [
    'slack/people-ops/',
    'confluence/people-ops/',
    'google_drive/shared_drives/people-ops/',
    'fireflies/interviews/',
  ],
  Legal: ['confluence/finance-and-legal/', 'google_drive/shared_drives/finance-and-legal/'],
  Marketing: ['google_drive/shared_drives/go-to-market/'],
  'Operations / IT': ['linear/business-ops/'],
};

/** ASCII key for a name: "Dr. Aisha Rahman" → "aisha.rahman", "Grace O'Connor" → "grace.oconnor". */
export function nameKey(name) {
  return name
    .replace(/^Dr\.\s+/, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('.');
}

const ENGINEERING = new Set([
  'Engineering',
  'Infrastructure & SRE',
  'Applied ML / Research',
  'Developer Experience',
]);
const CONFIDENTIAL_WORK = new Set([
  'Sales',
  'Customer Success & Support',
  'Solutions Engineering / Professional Services',
  'Security & Compliance',
  'Marketing',
]);

/**
 * Role, clearance and organization-wide ceiling from a directory entry (README, "Personas").
 *   leadership  Chief …, VP …, General Counsel       restricted; ceiling restricted for the
 *                                                    C-level and People/Finance/Legal, else
 *                                                    confidential
 *   managers    Director, Head, Manager, Lead         confidential / confidential (restricted
 *                                                    clearance in People, Finance, Legal)
 *   staff       everyone else                        ceiling internal; clearance confidential
 *                                                    where the work is (sales, customers,
 *                                                    security, marketing), restricted in
 *                                                    People/Finance/Legal, internal otherwise
 */
export function authorityOf(department, title) {
  const chief = /^Chief\b|General Counsel/.test(title);
  const vp = /^VP\b/.test(title);
  const manager = /Director|Head of|Manager|Lead\b/.test(title);
  const sensitive = LEADERSHIP_DEPARTMENTS.has(department);
  let tier;
  let clearance;
  let ceiling;
  if (chief || vp) {
    tier = 'leadership';
    clearance = 'restricted';
    ceiling = chief || sensitive ? 'restricted' : 'confidential';
  } else if (manager) {
    tier = 'manager';
    clearance = sensitive ? 'restricted' : 'confidential';
    ceiling = 'confidential';
  } else {
    tier = 'staff';
    clearance = sensitive
      ? 'restricted'
      : CONFIDENTIAL_WORK.has(department)
        ? 'confidential'
        : 'internal';
    ceiling = 'internal';
  }
  let role;
  if (department === 'Operations / IT' && tier === 'staff') {
    role = 'system_administrator';
    clearance = 'restricted';
    ceiling = 'restricted';
  } else if (department === 'Finance') role = tier === 'staff' ? 'performer' : 'finance_approver';
  else if (tier === 'leadership') role = 'project_owner';
  else if (department === 'Design / UX') role = 'design_authority';
  else if (department === 'Security & Compliance' && tier !== 'staff') role = 'quality_authority';
  else if (tier === 'manager')
    role = ENGINEERING.has(department) ? 'technical_authority' : 'reviewer';
  else role = 'performer';
  return { tier, role, clearance, ceiling };
}

/** The named personas the README and the tests use. */
export const PERSONAS = {
  'ava.chen': 'cto',
  'laura.bennett': 'cfo',
  'natalie.chen': 'records',
  'avery.johnson': 'account-executive',
  'owen.phillips': 'support-engineer',
  'grace.kim': 'kernel-engineer',
  'kimberly.park': 'vp-people',
  'aly.nguyen': 'hr-partner',
};

/** People from the directory (`{ departments: { name: [{ name, title, email, … }] } }`). */
export function peopleFromDirectory(directory) {
  const people = [];
  for (const [department, members] of Object.entries(directory.departments)) {
    for (const m of members) {
      const key = nameKey(m.name);
      const a = authorityOf(department, m.title);
      people.push({
        key,
        name: m.name.replace(/^Dr\.\s+/, ''),
        title: m.title,
        department,
        tier: a.tier,
        role: a.role,
        clearance: a.clearance,
        ceiling: a.ceiling,
        ...(PERSONAS[key] === undefined ? {} : { persona: PERSONAS[key] }),
        username: `${USERNAME_PREFIX}${key}`,
        email: `${key}@${EMAIL_DOMAIN}`,
        corpus_email: m.email,
      });
    }
  }
  people.sort((a, b) => a.key.localeCompare(b.key));
  return people;
}

/** The mailbox owner of gmail/<owner>/…, as a person key ("grace_oconnor" → "grace.oconnor"). */
export function mailboxOwner(sourcePath) {
  const parts = sourcePath.split('/');
  return parts[0] === 'gmail' && parts.length > 2 ? parts[1].replace(/_/g, '.') : undefined;
}

export function classify(sourcePath, peopleByKey) {
  const owner = mailboxOwner(sourcePath);
  const ownerPerson = owner === undefined ? undefined : peopleByKey.get(owner);
  const leadership =
    ownerPerson !== undefined &&
    (ownerPerson.tier === 'leadership' || LEADERSHIP_DEPARTMENTS.has(ownerPerson.department));
  for (const rule of CLASSIFICATION_RULES) {
    if (!sourcePath.startsWith(rule.match)) continue;
    if (rule.mailbox === 'leadership' && !leadership) continue;
    return {
      classification: rule.classification,
      rule: rule.match + (rule.mailbox ? ` (${rule.mailbox})` : ''),
    };
  }
  throw new Error(`no rule for ${sourcePath}`);
}

/** Directory people named in a mail's From/To/Cc headers (by display name). */
export function mailParticipants(content, peopleByName) {
  const found = new Set();
  for (const line of content.split('\n').slice(0, 8)) {
    const m = /^(From|To|Cc):\s*(.*)$/.exec(line);
    if (m === null) continue;
    for (const part of m[2].split(',')) {
      const name = part.replace(/<[^>]*>/, '').trim();
      const key = peopleByName.get(nameKey(name));
      if (key !== undefined) found.add(key);
    }
  }
  return [...found].sort();
}

/**
 * Who is granted a document: its mailbox owner and the directory people on the mail, and the
 * departments whose folders it is in — each only where the document is above their ceiling and
 * within their clearance (a grant where the role already reaches would be a second, unexplained
 * authority; one above a clearance would be refused).
 */
export function readersOf(doc, people, { participants = [] } = {}) {
  const c = rank(doc.classification);
  const candidates = new Set(participants);
  const owner = mailboxOwner(doc.source_path);
  if (owner !== undefined) candidates.add(owner);
  for (const p of people) {
    const folders = DEPARTMENT_FOLDERS[p.department] ?? [];
    if (folders.some((f) => doc.source_path.startsWith(f))) candidates.add(p.key);
  }
  const byKey = new Map(people.map((p) => [p.key, p]));
  return [...candidates]
    .filter((k) => {
      const p = byKey.get(k);
      return p !== undefined && c > rank(p.ceiling) && c <= rank(p.clearance);
    })
    .sort();
}

export const ARTIFACT_KINDS = {
  slack: 'message_snapshot',
  gmail: 'message_snapshot',
  github: 'source_code',
};
