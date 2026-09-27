// The decisions the TheAgentCompany fixture makes over the company's ownCloud drive: its people
// (the benchmark's own employee roster), what each may read, and how every file is classified.
// The README reproduces the tables; change them together.

export const CORPUS = 'theagentcompany';
export const KEY_PREFIX = 'tac-v1';
export const LEGAL_NAME = 'The Agent Company, Inc.';
export const EMAIL_DOMAIN = 'the-agent-company.example';
export const USERNAME_PREFIX = 'tac.';
/** The CTO founds the organization and migrates the drive (the roster has no CEO or IT admin). */
export const FOUNDER = 'sarah.johnson';
export const OFFICE = 'sarah.johnson';

const RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 };
export const rank = (c) => RANK[c];

/**
 * The roster of servers/rocketchat/npc/npc_definition.json (the AI assistant left out: it is not
 * a person). Role, clearance and ceiling are this fixture's decisions.
 */
export const PEOPLE = [
  ['Sarah Johnson', 'CTO', 'Executive', 'project_owner', 'restricted', 'restricted', 'cto'],
  [
    'David Wong',
    'Finance Director',
    'Finance',
    'finance_approver',
    'restricted',
    'confidential',
    'finance',
  ],
  [
    'Chen Xinyi',
    'Human Resources Manager',
    'Human Resources',
    'reviewer',
    'restricted',
    'confidential',
    'hr',
  ],
  ['Mark Johnson', 'Sales Director', 'Sales', 'reviewer', 'confidential', 'confidential', 'sales'],
  ['Jessica Lee', 'Marketing Manager', 'Marketing', 'reviewer', 'confidential', 'internal'],
  [
    'Li Ming',
    'Database Team Project Manager',
    'Engineering',
    'work_order_manager',
    'confidential',
    'internal',
  ],
  [
    'Huang Jie',
    'Product Manager (Search Engine Team)',
    'Product',
    'project_owner',
    'confidential',
    'internal',
  ],
  [
    'Zhang Wei',
    'Senior Software Engineer (Streaming Database Team)',
    'Engineering',
    'performer',
    'internal',
    'internal',
    'engineer',
  ],
  ['Wang Fang', 'AI Researcher (AI Team)', 'Research', 'performer', 'internal', 'internal'],
  [
    'Mike Chen',
    'Senior Software Engineer (AI Team)',
    'Engineering',
    'performer',
    'internal',
    'internal',
  ],
  [
    'Emily Zhou',
    'Software Engineer (Web Crawler Team)',
    'Engineering',
    'performer',
    'internal',
    'internal',
  ],
  ['Liu Qiang', 'Quality Assurance Engineer', 'Engineering', 'performer', 'internal', 'internal'],
  [
    'Priya Sharma',
    'Documentation Engineer',
    'Engineering',
    'performer',
    'internal',
    'public',
    'docs',
  ],
  ['Sophia Rodriguez', 'UX Designer', 'Design', 'design_authority', 'internal', 'internal'],
  [
    'Alex Turner',
    'Software Engineer (Low-Code Platform Team)',
    'Engineering',
    'performer',
    'internal',
    'internal',
  ],
  [
    'Emma Lewis',
    'Software Engineer (API Team)',
    'Engineering',
    'performer',
    'internal',
    'internal',
  ],
  [
    'Jessica Chen',
    'Frontend Software Engineer',
    'Engineering',
    'performer',
    'internal',
    'internal',
  ],
].map(([name, title, department, role, clearance, ceiling, persona]) => {
  const key = name.toLowerCase().replace(/[^a-z]+/g, '.');
  return {
    key,
    name,
    title,
    department,
    role,
    clearance,
    ceiling,
    ...(persona === undefined ? {} : { persona }),
    username: `${USERNAME_PREFIX}${key}`,
    email: `${key}@${EMAIL_DOMAIN}`,
  };
});

/** Classification by path under the drive's Documents/ folder. First match wins. */
export const CLASSIFICATION_RULES = [
  {
    match: 'Human Resources Team/',
    classification: 'restricted',
    why: 'personnel, salaries, immigration, resumes, passwords',
  },
  { match: 'Financials/TAC_salary.xlsx', classification: 'restricted', why: 'salaries' },
  {
    match: 'Q1 Planning and Allocation/salary_benefits_2024.xlsx',
    classification: 'restricted',
    why: 'salaries and benefits',
  },
  {
    match: 'Admin/TAC_personell_data.csv',
    classification: 'restricted',
    why: 'personnel data (I-9 fields)',
  },
  { match: 'Admin/i-9.pdf', classification: 'restricted', why: 'employment eligibility form' },
  {
    match: 'Financials/Annual Reports/',
    classification: 'public',
    why: 'published annual reports and 10-Ks',
  },
  {
    match: 'Data Analysis/Annual Reports/',
    classification: 'public',
    why: 'published annual reports',
  },
  {
    match: 'Financials/',
    classification: 'confidential',
    why: 'company finances, invoices, budgets',
  },
  {
    match: 'Administrative Specialist/',
    classification: 'confidential',
    why: 'vendor quotes and policy',
  },
  { match: 'Research/', classification: 'public', why: 'published research papers' },
  { match: 'TAC_overview.md', classification: 'public', why: 'company overview' },
  {
    match: '',
    classification: 'internal',
    why: 'everything else: admin, engineering, marketing, data analysis, planning',
  },
];

/** Need-to-know: the folders a department is granted where they exceed its ceiling. */
export const DEPARTMENT_FOLDERS = {
  Finance: ['Financials/', 'Administrative Specialist/', 'Q1 Planning and Allocation/'],
  'Human Resources': ['Human Resources Team/', 'Admin/TAC_personell_data.csv', 'Admin/i-9.pdf'],
  Sales: ['Administrative Specialist/'],
};

/** Files outside Documents/ are ownCloud's stock content, and media without text is left out. */
export function included(relPath) {
  if (!relPath.startsWith('Documents/')) return false;
  return !/\.(mp4|zip|whiteboard)$/i.test(relPath);
}

export function classify(relPath) {
  const inDocuments = relPath.replace(/^Documents\//, '');
  for (const rule of CLASSIFICATION_RULES) {
    if (inDocuments.startsWith(rule.match)) {
      return {
        classification: rule.classification,
        rule: rule.match === '' ? '(default)' : rule.match,
      };
    }
  }
  throw new Error(`no rule for ${relPath}`);
}

export function readersOf(doc, people) {
  const inDocuments = doc.path.replace(/^Documents\//, '');
  const c = rank(doc.classification);
  return people
    .filter((p) => (DEPARTMENT_FOLDERS[p.department] ?? []).some((f) => inDocuments.startsWith(f)))
    .filter((p) => c > rank(p.ceiling) && c <= rank(p.clearance))
    .map((p) => p.key)
    .sort();
}

export function artifactKindOf(relPath) {
  if (relPath.includes('/invoices_pdf/') || /receipt|bill\.pdf/i.test(relPath))
    return 'invoice_evidence';
  if (/\.(xlsx|ods|csv)$/i.test(relPath)) return 'dataset';
  if (/\.(png|jpe?g)$/i.test(relPath)) return 'binary';
  return 'document';
}

/**
 * The committed sample: files the company itself wrote (no third-party report or paper), one or
 * more of every classification, format and extraction method, and the HR files KF's content
 * rules refuse (they hold passwords and social-security numbers).
 */
export const SAMPLE_PATHS = [
  'Documents/TAC_overview.md',
  'Documents/Employee_Manual.odt',
  'Documents/Engineering/oncall_arrangement.txt',
  'Documents/Admin/Task_assignment.xlsx',
  'Documents/Admin/TAC_personell_data.csv',
  'Documents/Administrative Specialist/Reimbursement Policy.pdf',
  'Documents/Administrative Specialist/products.pdf',
  'Documents/Administrative Specialist/cloudtech_industries_quote.pdf',
  'Documents/Administrative Specialist/datacore_enterprise_quote.pdf',
  'Documents/Data Analysis/Coffee Shop/products.csv',
  'Documents/Data Analysis/Coffee Shop/analysis.txt',
  'Documents/Financials/budget.xlsx',
  'Documents/Financials/payments.xlsx',
  'Documents/Financials/TAC_salary.xlsx',
  'Documents/Financials/Qualified_R&D_Activities.md',
  'Documents/Financials/July-September 2024 Financials.ods',
  'Documents/Financials/invoices_pdf/INV0000.pdf',
  'Documents/Financials/invoices_pdf/INV0001.pdf',
  'Documents/Financials/invoices_pdf/INV0002.pdf',
  'Documents/Financials/receipt.jpg',
  'Documents/Human Resources Team/salary.txt',
  'Documents/Human Resources Team/Personnell_File.odt',
  'Documents/Human Resources Team/Salary_Analysis_Report.odt',
  'Documents/Human Resources Team/Employee Password/password-rules.odt',
  'Documents/Human Resources Team/Employee Password/password-collection-with-error.odt',
  'Documents/Human Resources Team/Attendance/april-attendance-data.csv',
  'Documents/Human Resources Team/Immigration/Dates_For_Filing.png',
  'Documents/Marketing/Task_assignments.xlsx',
  'Documents/Q1 Planning and Allocation/core_competencies.xlsx',
  'Documents/Q1 Planning and Allocation/Effort.Planning.2025.docx',
  'Documents/Research/Noise Simulation/noise_simulation_analysis_sheet.txt',
];
