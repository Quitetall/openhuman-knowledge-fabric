// Véracier's roles as composable presets of scope (ADR 0040 decision 4; KF-SAS-RQ-269).
//
// The fixture used to say every need-to-know decision once per person: 1 004 documents and 69
// records, each granted to each of its readers by its own `grant_access`. Where a document's
// readers are EXACTLY a team — the same five people of the AV-3000 programme read eighty of them —
// that is one decision ("the AV-3000 programme reads its documents") taken eighty times five times.
// Here it is taken once: the team is a role, the documents are its preset, and the team's members
// hold the role. A document read by only part of a team keeps its per-person grants, because a
// team preset would widen it; that is what "where faithful" means, and nobody's corpus changes.
//
// The hierarchy the owner described (Q16) sits above the teams:
//
//   chief_executive ⊇ executive ⊇ staff          staff reads the living organization overview
//   chief_executive ⊇ quality_director ⊇ staff   (a diamond: staff is reached two ways)
//   engineer ⊇ staff
//   <team> ⊇ staff                                each team reads exactly what all of it reads
//
// The organization-wide reading of the executives and the quality director is what their role
// assignments' ceilings already gave them (the authority matrix VER-GOV-2026-01): a preset of
// the same scope and ceiling, so the hierarchy is visible and changes nothing anybody can read.
// `engineer` carries no scope of its own here: the overlay's need-to-know is by team, so an
// engineer's engineering documents arrive through their team's preset, and the role says what
// they are without granting more than the matrix does.

export const ROLE_DEFINITIONS = [
  ['staff', 'Every person of the organization: reads the living organization overview.'],
  ['engineer', 'An engineer of the organization; includes staff.'],
  [
    'quality_director',
    'Directs quality across the group: reads the organization up to confidential.',
  ],
  ['executive', 'A member of the executive committee: reads the organization up to confidential.'],
  ['chief_executive', 'The chief executive: includes the executive and quality director presets.'],
  ['av3000_programme', 'The AV-3000 servo-valve programme team at Véracier Aero.'],
  ['nusafe_programme', 'The NuSafe VP-200 nuclear valve programme team at Véracier Énergie.'],
  ['hydraulics_gmbh', 'The hydraulics engineering and quality team at Véracier GmbH.'],
  ['defence_uk', 'The defence programmes team at Véracier UK.'],
  ['harness_casablanca', 'The AeroHarness cabling team at Véracier Maroc.'],
];

/** Each team is a set of people; a document or record read by exactly that set is its preset. */
export const TEAMS = {
  av3000_programme: [
    'audrey.lescure',
    'mathieu.roux',
    'pauline.besson',
    'sebastien.bonnefoy',
    'sophie.pelissier',
  ],
  nusafe_programme: ['agnes.lemaire', 'benoit.charrier', 'gilles.perrin', 'nicolas.teyssier'],
  hydraulics_gmbh: ['anja.scholz', 'jonas.keller', 'matthias.vogt', 'petra.zimmermann'],
  defence_uk: ['david.owens', 'james.cartwright', 'sarah.mitchell', 'thomas.whitfield'],
  harness_casablanca: ['amina.el.fassi', 'nadia.tazi', 'rachid.benali', 'youssef.amrani'],
};

export const INCLUSIONS = [
  ['engineer', 'staff'],
  ['quality_director', 'staff'],
  ['executive', 'staff'],
  ['chief_executive', 'executive'],
  ['chief_executive', 'quality_director'],
  ...Object.keys(TEAMS).map((team) => [team, 'staff']),
];

/** Organization-wide reading, as the matrix's ceilings already grant it to these holders. */
export const ORGANIZATION_WIDE = [
  ['chief_executive', 'restricted'],
  ['executive', 'confidential'],
  ['quality_director', 'confidential'],
];

/** Who holds which preset role, by person key. Everybody reaches `staff` one way or another. */
export function holders(people) {
  const byPersona = (persona) => people.find((p) => p.persona === persona).key;
  const ceo = byPersona('ceo');
  const quality = byPersona('quality');
  // The group directors whose matrix ceiling is confidential (VER-GOV-2026-01).
  const executives = people
    .filter(
      (p) =>
        p.entity === 'veracier_sa' &&
        p.ceiling === 'confidential' &&
        p.key !== quality &&
        p.key !== ceo,
    )
    .map((p) => p.key);
  const engineers = [
    'mathieu.roux',
    'pauline.besson',
    'sebastien.bonnefoy',
    'agnes.lemaire',
    'nicolas.teyssier',
    'james.cartwright',
    'kevin.sullivan',
    'anja.scholz',
    'matthias.vogt',
    'melanie.castaing',
  ];
  const held = new Map(people.map((p) => [p.key, new Set()]));
  const give = (key, role) => held.get(key)?.add(role);
  give(ceo, 'chief_executive');
  give(quality, 'quality_director');
  for (const key of executives) give(key, 'executive');
  for (const key of engineers) give(key, 'engineer');
  for (const [team, members] of Object.entries(TEAMS)) {
    for (const key of members) give(key, team);
  }
  for (const [key, roles] of held) if (roles.size === 0) give(key, 'staff');
  return held;
}

const setKey = (keys) => [...keys].sort().join('\u0000');
const TEAM_BY_READERS = new Map(
  Object.entries(TEAMS).map(([team, members]) => [setKey(members), team]),
);

/** The team whose preset grants a document or record read by exactly `readers`, if any. */
export function teamOf(readers) {
  return readers === undefined || readers.length === 0
    ? undefined
    : TEAM_BY_READERS.get(setKey(readers));
}
