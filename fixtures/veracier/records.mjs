// The governed records the Véracier overlay adds over its documents, each performed by a named
// person as a dispatched act. The facts come from the cited documents (NCR numbers, lots,
// measurements and dispositions are the corpus's own), or are plain planning decisions a group
// like this one would record (projects, work packages, decisions).
//
// Shape of a record:
//   ref            stable, unique; the act's idempotency key is derived from it
//   type           the action type dispatched (ontology/action-types.yaml), or record_observation
//                  (sent to POST /capture/observation, the one-gesture surface)
//   actor          the person key of whoever performs it
//   entity, area   where the record belongs, for need-to-know (area is a folder of the corpus)
//   classification the record's own classification
//   payload        the act's payload; `@doc:<doc_id>` is that document's PDF artifact,
//                  `@text:<doc_id>` its extracted-text artifact, `@textversion:<doc_id>` the
//                  text artifact's version, `@rec:<key>` an earlier record, `@person:<key>`
//                  a person, `@org:<key>` a counterparty organization; `@title:<doc_id>` inside
//                  a string is replaced by the generator with that document's title
//   targets        for an act on an existing record (then `creates: false`)
//   evidence       doc_ids the record rests on; linked after the act (see load.mjs)

export const COUNTERPARTIES = [
  {
    key: 'forges',
    legal_name: 'Forges Martelliere S.A.',
    kind: 'supplier',
    contact: 'Gérard Martellière',
  },
  {
    key: 'sudelec',
    legal_name: 'SudElec Maroc S.A.',
    kind: 'supplier',
    contact: 'Hassan Ouazzani',
  },
  { key: 'baltic', legal_name: 'Baltic Composites OU', kind: 'supplier', contact: 'Kristjan Saar' },
  {
    key: 'xinhua',
    legal_name: 'Shanghai Xinhua Precision Machining Co. Ltd',
    kind: 'supplier',
    contact: 'Zhou Minghui',
  },
  {
    key: 'rhein',
    legal_name: 'Rhein-Metall Prazision GmbH',
    kind: 'supplier',
    contact: 'Uwe Brandstetter',
  },
  {
    key: 'titan',
    legal_name: 'Titan Fluid Systems Inc',
    kind: 'supplier',
    contact: 'Dale Whitcomb',
  },
  {
    key: 'savoie',
    legal_name: 'Acieries de Savoie S.A.',
    kind: 'supplier',
    contact: 'Florence Bauduin',
  },
];

const AERO = { entity: 'veracier_aero' };
const SA = { entity: 'veracier_sa' };
const MAROC = { entity: 'veracier_maroc' };
const PRECISTEC = { entity: 'precistec' };

export const RECORDS = [
  // ── Products and their configuration ─────────────────────────────────────────────────
  {
    ref: 'ps-av3000',
    type: 'register_product_system',
    actor: 'farida.benziane',
    ...AERO,
    area: 'technique/',
    classification: 'internal',
    reason: 'AeroValve AV-3000 servo-valve, the Aero product the AV-3000 specifications describe',
    payload: {
      title: 'AeroValve AV-3000 — servo-valve hydraulique',
      product_kind: 'product',
      responsible_owner: '@person:audrey.lescure',
    },
    evidence: ['DOC-fcc8783b', 'DOC-95850a74'],
  },
  {
    ref: 'ps-ah100',
    type: 'register_product_system',
    actor: 'farida.benziane',
    ...MAROC,
    area: 'production/',
    classification: 'internal',
    reason: 'AeroHarness AH-100-G2 main electrical harness built in Casablanca for the AN-320neo',
    payload: {
      title: 'AeroHarness AH-100-G2 — faisceau électrique principal',
      product_kind: 'product',
      responsible_owner: '@person:rachid.benali',
    },
    evidence: ['DOC-98fe83f3'],
  },
  {
    ref: 'ps-optishield',
    type: 'register_product_system',
    actor: 'farida.benziane',
    entity: 'veracier_defense',
    area: 'technique/',
    classification: 'restricted',
    reason: 'OptiShield S-500 optronic system, export-controlled defence product',
    payload: {
      title: 'OptiShield S-500 — système optronique',
      product_kind: 'product',
      responsible_owner: '@person:virginie.marchand',
    },
  },
  {
    ref: 'ps-nusafe',
    type: 'register_product_system',
    actor: 'farida.benziane',
    entity: 'veracier_energie',
    area: 'technique/',
    classification: 'internal',
    reason: 'NuSafe VP-200 nuclear-grade valve under RCC-M qualification at Valence',
    payload: {
      title: 'NuSafe VP-200 — vanne de sûreté nucléaire',
      product_kind: 'product',
      responsible_owner: '@person:gilles.perrin',
    },
  },
  {
    ref: 'ci-av3000-body',
    type: 'promote_configuration_item',
    actor: 'elodie.marchetti',
    ...AERO,
    area: 'technique/',
    classification: 'internal',
    reason:
      'Forged TA6V valve body FDB-AV3-001, the part behind the recurring Forges Martelliere NCRs',
    payload: {
      title: 'Corps de valve forgé TA6V FDB-AV3-001',
      item_kind: 'mechanical',
      part_number: 'FDB-AV3-001',
      revision_label: 'F',
      parent_system: '@rec:ps-av3000',
    },
  },
  {
    ref: 'ci-av3000-spec',
    type: 'promote_configuration_item',
    actor: 'elodie.marchetti',
    ...AERO,
    area: 'technique/',
    classification: 'internal',
    reason: 'Specification SP-AV3000 revision F (2024), the current definition of the AV-3000',
    payload: {
      title: 'Spécification SP-AV3000 Rev F',
      item_kind: 'document',
      part_number: 'SP-AV3000',
      revision_label: 'F',
      parent_system: '@rec:ps-av3000',
    },
    evidence: ['DOC-fcc8783b'],
  },
  {
    ref: 'ci-av3000-control-plan',
    type: 'promote_configuration_item',
    actor: 'elodie.marchetti',
    ...AERO,
    area: 'technique/',
    classification: 'internal',
    reason: 'Control plan CP-AV3000 revision F, cited by the lot 0312 records',
    payload: {
      title: 'Plan de contrôle CP-AV3000 Rev F',
      item_kind: 'document',
      part_number: 'CP-AV3000',
      revision_label: 'F',
      parent_system: '@rec:ps-av3000',
    },
  },
  {
    ref: 'bl-av3000-f',
    type: 'define_baseline',
    actor: 'elodie.marchetti',
    ...AERO,
    area: 'technique/',
    classification: 'internal',
    reason: 'Product baseline of the AV-3000 at specification revision F',
    payload: {
      title: 'Baseline produit AV-3000 Rev F',
      baseline_kind: 'product',
      contained_nodes: [
        '@rec:ci-av3000-body',
        '@rec:ci-av3000-spec',
        '@rec:ci-av3000-control-plan',
      ],
    },
  },

  // ── Requirements (SP-AV3000 Rev F and the lot records that apply it) ──────────────────
  ...[
    [
      'req-port-b',
      'Alésage du port B hydraulique',
      "La cote d'alésage du port B hydraulique est de 25,000 mm +0,010/-0,000 mm.",
      'inspection',
    ],
    [
      'req-leak',
      'Étanchéité sous pression',
      'La servo-valve ne présente aucune fuite à 315 bar (1,5 fois la pression de service) maintenus 5 minutes, selon TP-QA-042 Rev. C.',
      'test',
    ],
    [
      'req-fatigue',
      'Tenue en fatigue',
      'Le corps de valve endure 10^7 cycles sans amorce de fissure visible (ASTM E466, R = 0,1, 10 Hz, 23 +/- 2 °C).',
      'test',
    ],
    [
      'req-ndt',
      'Ressuage fluorescent',
      'Aucune indication linéaire supérieure à 1,5 mm au ressuage fluorescent (NAS 410 / EN 4179 niveau 2).',
      'inspection',
    ],
    [
      'req-material',
      'Matière du corps de valve',
      'Le corps de valve est en alliage de titane Ti-6Al-4V conforme à AMS 4928, certificat matière 3.1 selon EN 10204.',
      'inspection',
    ],
    [
      'req-cleanliness',
      'Propreté du fluide hydraulique',
      'Les essais fonctionnels se font avec un fluide hydraulique de propreté classe 6 selon NAS 1638.',
      'test',
    ],
    [
      'req-marking',
      'Marquage des pièces',
      'Chaque pièce porte le numéro de lot, la référence, le numéro de série, la date de fabrication et le poinçon du contrôleur, par micro-percussion.',
      'inspection',
    ],
    [
      'req-packaging',
      'Conditionnement',
      'Les produits sont conditionnés selon MIL-STD-2073.',
      'inspection',
    ],
  ].map(([key, title, statement, method]) => ({
    ref: key,
    type: 'define_requirement',
    actor: 'sebastien.bonnefoy',
    ...AERO,
    area: 'technique/',
    classification: 'internal',
    reason: `Requirement of SP-AV3000 Rev F: ${title}`,
    payload: {
      title: `AV-3000 — ${title}`,
      statement,
      requirement_kind: 'system',
      verification_method: method,
    },
    evidence: ['DOC-fcc8783b'],
  })),

  // ── Tests of lot 2024-0312 (the EASA audit dossier, QUAL-01) ──────────────────────────
  ...[
    ['test-0312-salt', 'brouillard salin', 'DOC-523f8b94'],
    ['test-0312-thermal', 'choc thermique', 'DOC-199cafc2'],
    ['test-0312-ndt', 'contrôle non destructif', 'DOC-635896d8'],
    ['test-0312-leak', 'étanchéité sous pression', 'DOC-b823c25b'],
    ['test-0312-fatigue', 'fatigue', 'DOC-02a98910'],
    ['test-0312-functional', 'fonctionnel', 'DOC-1197f7b3'],
    ['test-0312-vibration', 'vibrations aléatoires', 'DOC-588535b4'],
  ].map(([key, title, doc]) => ({
    ref: key,
    type: 'register_test',
    actor: 'pauline.besson',
    ...AERO,
    area: 'qualite/',
    classification: 'internal',
    reason: 'Acceptance test of lot LOT-2024-0312, recorded from its test report',
    payload: {
      title: `Lot 2024-0312 — essai ${title}`,
      test_kind: 'execution',
      objective: `Essai ${title} d'acceptation du lot AV-3000 LOT-2024-0312 selon PR-QA-042.`,
      result_artifact: `@doc:${doc}`,
    },
    evidence: [doc],
  })),

  // ── Nonconformities and CAPAs (qualite/rnc, qualite/non_conformites, qualite/capa) ──────
  {
    ref: 'nc-fb-2024-007',
    type: 'raise_nonconformity',
    actor: 'karim.hadj.ali',
    ...SA,
    area: 'qualite/',
    classification: 'internal',
    reason: 'RNC-FB-2024-007 as reported by Toulouse incoming inspection',
    payload: {
      title: 'RNC-FB-2024-007 — Forges Martelliere, corps de valve TA6V hors tolérance',
      severity: 'major',
      description:
        'Lot FB-2024-0156 : diamètre extérieur 64,82 mm pour 65,00 +/- 0,10 mm, 8 pièces sur 50 (16 %). Cause : usure des matrices de forge. Lot refusé, 42 pièces acceptées après tri.',
      subject_id: '@rec:ci-av3000-body',
    },
    evidence: ['DOC-183f009c'],
  },
  {
    ref: 'nc-fb-2024-009',
    type: 'raise_nonconformity',
    actor: 'karim.hadj.ali',
    ...SA,
    area: 'qualite/',
    classification: 'internal',
    reason: 'RNC-FB-2024-009 as reported by incoming inspection',
    payload: {
      title: 'RNC-FB-2024-009 — Forges Martelliere, porosité interne barres TA6V',
      severity: 'major',
      description:
        'Lot FB-2024-0198 : indications ultrasonores > 1 mm à mi-épaisseur sur 3 barres sur 40 (spécification : aucune > 0,8 mm). Cause : refroidissement trop rapide au forgeage.',
    },
    evidence: ['DOC-0ce801a9'],
  },
  {
    ref: 'nc-fb-2024-011',
    type: 'raise_nonconformity',
    actor: 'karim.hadj.ali',
    ...SA,
    area: 'qualite/',
    classification: 'internal',
    reason: 'RNC-FB-2024-011 as reported by incoming inspection',
    payload: {
      title: 'RNC-FB-2024-011 — Forges Martelliere, état de surface 15CDV6',
      severity: 'minor',
      description:
        'Lot FB-2024-0212 : Ra 3,2 µm pour une spécification < 1,6 µm, 7 pièces sur 50 refusées. Coût : 24 500 EUR. Analyse en cours.',
    },
    evidence: ['DOC-c0b6eedd'],
  },
  {
    ref: 'nc-fb-2025-002',
    type: 'raise_nonconformity',
    actor: 'karim.hadj.ali',
    ...SA,
    area: 'qualite/',
    classification: 'internal',
    reason: 'RNC-FB-2025-002: the defect recurs after CAPA-FB-2024-003',
    payload: {
      title: 'RNC-FB-2025-002 — Forges Martelliere, récurrence malgré CAPA-FB-2024-003',
      severity: 'major',
      description:
        'Lot FB-2025-0034 : diamètre 64,88 mm, 5 pièces sur 45 (11 %). La mesure laser n’est opérationnelle que sur 1 des 3 presses ; les actions du CAPA ne sont pas pleinement efficaces.',
      subject_id: '@rec:ci-av3000-body',
    },
    evidence: ['DOC-6aaf86d2'],
  },
  {
    ref: 'nc-0312-001',
    type: 'raise_nonconformity',
    actor: 'sophie.pelissier',
    ...AERO,
    area: 'qualite/',
    classification: 'internal',
    reason: 'NC-0312-001 found at Op.60 dimensional control',
    payload: {
      title: 'NC-0312-001 — alésage port B, lot 2024-0312',
      severity: 'minor',
      description:
        'Alésage port B mesuré 25,015 mm pour 25,000 +0,010/-0,000 mm sur SN-0312-017, -031, -044. Cause : usure de la fraise carbure au-delà de 250 pièces. Concession EC-2024-0089 : utilisation en l’état.',
      subject_id: '@rec:ps-av3000',
    },
    evidence: ['DOC-0da50d6f'],
  },
  {
    ref: 'nc-bc-2025-002',
    type: 'raise_nonconformity',
    actor: 'sophie.pelissier',
    ...AERO,
    area: 'qualite/',
    classification: 'internal',
    reason: 'NCR-BC-2025-002 from ultrasonic C-scan at incoming inspection',
    payload: {
      title: 'NCR-BC-2025-002 — Baltic Composites, orientation des fibres CFRP',
      severity: 'major',
      description:
        'Lot BC-2025-0034 : orientation mesurée 42/48° pour +/- 45° spécifiés. Lot en quarantaine, revue par éléments finis en cours.',
    },
    evidence: ['DOC-6e9b3842'],
  },
  {
    ref: 'nc-sx-2024-012',
    type: 'raise_nonconformity',
    actor: 'sophie.pelissier',
    ...AERO,
    area: 'qualite/',
    classification: 'internal',
    reason: 'NCR-SX-2024-012: certificate and material disagree',
    payload: {
      title: 'NCR-SX-2024-012 — Shanghai Xinhua, matière non conforme au certificat',
      severity: 'critical',
      description:
        'Lot SX-2024-0089 : certificat AISI 316L, analyse XRF Mo 1,8 % (2,0-3,0 % requis). 25 pièces. Matière non certifiée d’une source secondaire.',
    },
    evidence: ['DOC-992c3508'],
  },
  {
    ref: 'nc-rm-2024-001',
    type: 'raise_nonconformity',
    actor: 'petra.zimmermann',
    entity: 'veracier_gmbh',
    area: 'qualite/',
    classification: 'internal',
    reason: 'Abweichungsbericht RNC-RM-2024-001',
    payload: {
      title: 'RNC-RM-2024-001 — Rhein-Metall Präzision, Rauheit Innenbohrung',
      severity: 'minor',
      description:
        'Los RM-2024-0067: Ra 1,2 µm statt < 0,8 µm, 6 von 30 Teilen. Schleifwerkzeug über Standzeit genutzt.',
    },
    evidence: ['DOC-918fdba5'],
  },
  {
    ref: 'nc-tf-2024-003',
    type: 'raise_nonconformity',
    actor: 'samuel.okafor',
    entity: 'veracier_inc',
    area: 'qualite/',
    classification: 'internal',
    reason: 'NCR-TF-2024-003 found by FTIR at incoming inspection',
    payload: {
      title: 'NCR-TF-2024-003 — Titan Fluid Systems, NBR O-rings instead of HNBR',
      severity: 'major',
      description:
        '100 hydraulic fittings TF-VRC-HFA-012 fitted with NBR O-rings instead of HNBR per MIL-PRF-83248. Lot quarantined, rework with HNBR.',
    },
    evidence: ['DOC-d1aceb2f'],
  },
  {
    ref: 'nc-sm-2024-005',
    type: 'raise_nonconformity',
    actor: 'amina.el.fassi',
    ...MAROC,
    area: 'qualite/',
    classification: 'internal',
    reason: 'RNC-SM-2024-005 from end-of-line functional test',
    payload: {
      title: 'RNC-SM-2024-005 — SudElec Maroc, régulateur U7 monté à 180°',
      severity: 'major',
      description:
        'Lot SM-2024-0089 : 12 cartes PCB-AH100-003 sur 200 en court-circuit (U7 LM317 inversé). Erreur de fichier de placement, FAI de début de lot non réalisé. 12 rebuts, 3 600 EUR.',
      subject_id: '@rec:ps-ah100',
    },
    evidence: ['DOC-66d5efc4'],
  },
  {
    ref: 'capa-fb-2024-003',
    type: 'open_capa',
    actor: 'karim.hadj.ali',
    ...SA,
    area: 'qualite/',
    classification: 'internal',
    reason: 'CAPA-FB-2024-003 on recurring TA6V forging nonconformities',
    payload: {
      title: 'CAPA-FB-2024-003 — Forges Martelliere, dérive dimensionnelle TA6V',
      capa_kind: 'both',
      problem_statement:
        '4 RNC en 6 mois sur corps de valve TA6V, taux de rejet moyen 12 %. Usure accélérée des matrices, pas de SPC en ligne chez le fournisseur.',
      effectiveness_criterion: 'Taux de rejet < 2 % sur les 3 lots suivants.',
      nonconformities: ['@rec:nc-fb-2024-007', '@rec:nc-fb-2024-009'],
    },
    evidence: ['DOC-94d1216b'],
  },
  {
    ref: 'capa-bc-2025-001',
    type: 'open_capa',
    actor: 'sophie.pelissier',
    ...AERO,
    area: 'qualite/',
    classification: 'internal',
    reason: 'CAPA-BC-2025-001 on fibre orientation deviations',
    payload: {
      title: 'CAPA-BC-2025-001 — Baltic Composites, orientation des fibres',
      capa_kind: 'corrective',
      problem_statement:
        '2 NCR au T1 2025 sur l’orientation des fibres des panneaux CFRP, défaut nouveau.',
      effectiveness_criterion:
        'Aucune déviation d’orientation sur les 3 lots suivants (mesure laser en cours de fabrication).',
      nonconformities: ['@rec:nc-bc-2025-002'],
    },
    evidence: ['DOC-c270e4e0'],
  },
  {
    ref: 'capa-sm-2024-001',
    type: 'open_capa',
    actor: 'amina.el.fassi',
    ...MAROC,
    area: 'qualite/',
    classification: 'internal',
    reason: 'CAPA-SM-2024-001 on recurring soldering defects',
    payload: {
      title: 'CAPA-SM-2024-001 — SudElec Maroc, défauts de brasure',
      capa_kind: 'both',
      problem_statement:
        'Défauts de brasure récurrents (soudures froides, billes, excès de flux), taux moyen 3,2 % pour un objectif < 0,5 %.',
      effectiveness_criterion:
        'Taux de défaut < 0,5 % sur les 3 lots suivants, AOI en sortie de ligne.',
      nonconformities: ['@rec:nc-sm-2024-005'],
    },
    evidence: ['DOC-55af5ab0'],
  },

  // ── Suppliers and their agreements (contrats/fournisseur) ─────────────────────────────
  ...[
    [
      'forges',
      'Forges Martelliere S.A.',
      'critical',
      'Pièces forgées TA6V et 15CDV6 (corps de valve AV-3000)',
      'DOC-dc65679b',
      '2022-01-01',
      SA,
    ],
    [
      'sudelec',
      'SudElec Maroc S.A.',
      'significant',
      'Cartes électroniques AH-100 (PCB-AH100-003)',
      'DOC-e3bbb893',
      '2023-01-01',
      MAROC,
    ],
    [
      'baltic',
      'Baltic Composites OU',
      'significant',
      'Panneaux composites carbone BC-VRC-CFP-012',
      'DOC-92a836a9',
      '2023-01-01',
      AERO,
    ],
    [
      'rhein',
      'Rhein-Metall Prazision GmbH',
      'standard',
      'Carters usinés de précision RM-VRC-HOU-003',
      'DOC-d12104dc',
      '2021-01-01',
      { entity: 'veracier_gmbh' },
    ],
    [
      'titan',
      'Titan Fluid Systems Inc',
      'standard',
      'Raccords hydrauliques TF-VRC-HFA-012',
      'DOC-95f059d3',
      '2020-01-01',
      { entity: 'veracier_inc' },
    ],
  ].flatMap(([org, name, criticality, scope, doc, starts, where]) => [
    {
      ref: `supplier-${org}`,
      type: 'register_supplier',
      actor: 'isabelle.roche',
      ...where,
      area: 'contrats/fournisseur/',
      classification: 'confidential',
      reason: `${name} on the approved supplier list for ${scope}`,
      payload: {
        title: `Fournisseur — ${name}`,
        organization: `@org:${org}`,
        criticality,
        scope_of_supply: scope,
      },
      evidence: [doc],
    },
    {
      ref: `engagement-${org}`,
      type: 'record_engagement',
      actor: 'isabelle.roche',
      ...where,
      area: 'contrats/fournisseur/',
      classification: 'confidential',
      reason: `Supply agreement with ${name}, as signed`,
      payload: {
        title: `Contrat-cadre de fourniture — ${name}`,
        counterparty: `@org:${org}`,
        engagement_kind: 'supplier',
        starts_on: starts,
        agreement_artifact: `@doc:${doc}`,
      },
      evidence: [doc],
    },
  ]),

  // ── Risks ──────────────────────────────────────────────────────────────────────────────
  {
    ref: 'risk-forges-rj',
    type: 'identify_risk',
    actor: 'isabelle.roche',
    ...SA,
    area: 'rapports/achats/',
    classification: 'confidential',
    reason: 'Forges Martelliere in receivership (PROC-01): single source of TA6V forgings',
    payload: {
      title: 'Redressement judiciaire de Forges Martelliere — rupture d’approvisionnement TA6V',
      risk_kind: 'supplier',
      description:
        'Forges Martelliere, source unique des corps de valve TA6V de l’AV-3000, est en redressement judiciaire. Impact production, plan de contingence et qualification d’Aciéries de Savoie en second source.',
      severity: 'high',
      probability: 'likely',
    },
    evidence: ['DOC-fdfc1a37', 'DOC-9f36186f', 'DOC-7823658d', 'DOC-29949d76'],
  },
  {
    ref: 'risk-precistec-sanctions',
    type: 'identify_risk',
    actor: 'jean.philippe.garnier',
    ...PRECISTEC,
    area: 'contrats/',
    classification: 'confidential',
    reason: 'Inherited Précis-Tec contracts with sanctioned counterparties (CEO-01)',
    payload: {
      title: 'Contrats hérités de Précis-Tec avec des entités sanctionnées',
      risk_kind: 'business',
      description:
        'Deux contrats hérités (Severneft, RosNuclear) exposent le groupe aux sanctions de l’UE ; un contrat d’agent commercial présente un risque de conformité anticorruption.',
      severity: 'critical',
      probability: 'certain',
    },
    evidence: ['DOC-a28fc9ca', 'DOC-6527c5c5'],
  },
  {
    ref: 'risk-aeronord-penalties',
    type: 'identify_risk',
    actor: 'audrey.lescure',
    ...AERO,
    area: 'contrats/',
    classification: 'confidential',
    reason: 'Late-delivery penalties under the Aeronord framework agreement (AERO-02)',
    payload: {
      title: 'Pénalités de retard Aeronord sur l’AV-3000',
      risk_kind: 'business',
      description:
        'Le contrat-cadre et son avenant 2025 prévoient 0,5 % par semaine de retard, plafonnés à 10 % de la commande ; la montée en cadence de 30 % accroît l’exposition.',
      severity: 'high',
      probability: 'possible',
    },
    evidence: ['DOC-af093afe', 'DOC-74612a30'],
  },
  {
    ref: 'risk-aeronord-capacity',
    type: 'identify_risk',
    actor: 'laurent.pasquier',
    ...SA,
    area: 'production/',
    classification: 'internal',
    reason: 'Aeronord ramp-up of 30% against site capacity (OPS-01)',
    payload: {
      title: 'Capacité insuffisante pour la montée en cadence Aeronord +30 %',
      risk_kind: 'project',
      description:
        'Les plans de charge 2025 de Toulouse et de Casablanca ne couvrent pas la cadence Aeronord 2025-2028 sans investissement.',
      severity: 'high',
      probability: 'likely',
    },
    evidence: ['DOC-3f99319f', 'DOC-44235765', 'DOC-3447dcab'],
  },
  {
    ref: 'risk-nis2',
    type: 'identify_risk',
    actor: 'marc.lefevre',
    ...SA,
    area: 'securite/',
    classification: 'restricted',
    reason: 'Essential systems in NIS2 scope and the gaps found (CISO-02)',
    payload: {
      title: 'Lacunes NIS2 sur les systèmes essentiels',
      risk_kind: 'cybersecurity',
      description:
        'Plusieurs systèmes essentiels du groupe entrent dans le périmètre NIS2 ; l’analyse d’écart relève des lacunes de détection et de gestion des incidents.',
      severity: 'high',
      probability: 'possible',
    },
  },

  // ── Projects and work packages ────────────────────────────────────────────────────────
  {
    ref: 'prj-ramp-up',
    type: 'create_initiative',
    actor: 'laurent.pasquier',
    ...SA,
    area: 'production/',
    classification: 'internal',
    reason: 'Group programme to absorb the Aeronord ramp-up',
    payload: {
      title: 'Montée en cadence AV-3000 pour Aeronord (+30 %)',
      project_code: 'VER-OPS-2025-01',
      objective:
        'Porter la capacité AV-3000 et AH-100-G2 à la cadence Aeronord 2025-2028 sans dégrader la qualité livrée.',
      sponsor_id: '@person:helene.daubrac',
    },
    evidence: ['DOC-3447dcab', 'DOC-3f99319f', 'DOC-44235765'],
  },
  {
    ref: 'wp-toulouse-machining',
    type: 'create_work_package',
    actor: 'laurent.pasquier',
    ...AERO,
    area: 'production/',
    classification: 'internal',
    reason: 'Second machining line in Toulouse',
    payload: {
      project_id: '@rec:prj-ramp-up',
      title: 'Ligne d’usinage n°2 à Toulouse',
      scope_statement: 'Installer et qualifier une seconde ligne d’usinage des corps AV-3000.',
      acceptance_criterion:
        'Capabilité Cpk > 1,67 sur les cotes clés, 3 lots consécutifs conformes.',
    },
    evidence: ['DOC-75a5b48f'],
  },
  {
    ref: 'wp-second-source',
    type: 'create_work_package',
    actor: 'isabelle.roche',
    ...SA,
    area: 'rapports/achats/',
    classification: 'internal',
    reason: 'Second source for TA6V forgings',
    payload: {
      project_id: '@rec:prj-ramp-up',
      title: 'Qualification d’Aciéries de Savoie en second source TA6V',
      scope_statement: 'Audit, FAI et premiers lots de corps forgés TA6V chez Aciéries de Savoie.',
      acceptance_criterion: 'FAI conforme et taux de rejet < 2 % sur 3 lots.',
    },
    evidence: ['DOC-29949d76'],
  },
  {
    ref: 'wp-casablanca-extension',
    type: 'create_work_package',
    actor: 'rachid.benali',
    ...MAROC,
    area: 'production/',
    classification: 'internal',
    reason: 'Second harness line in the Casablanca free zone',
    payload: {
      project_id: '@rec:prj-ramp-up',
      title: 'Extension Casablanca — ligne faisceaux n°2',
      scope_statement:
        'Ouvrir une seconde ligne de faisceaux AH-100-G2 dans l’usine de la zone franche.',
      acceptance_criterion:
        'FAI EN 9102 conforme sur la nouvelle ligne et cadence nominale tenue un mois.',
    },
    evidence: ['DOC-d4f0078d'],
  },
  {
    ref: 'prj-precistec',
    type: 'create_initiative',
    actor: 'jean.philippe.garnier',
    ...PRECISTEC,
    area: 'contrats/',
    classification: 'confidential',
    reason: 'Post-acquisition integration of Précis-Tec',
    payload: {
      title: 'Intégration post-acquisition de Précis-Tec',
      project_code: 'VER-MA-2025-01',
      objective:
        'Cartographier et traiter les risques des contrats hérités de Précis-Tec dans les six mois suivant l’acquisition.',
      sponsor_id: '@person:helene.daubrac',
    },
    evidence: ['DOC-a28fc9ca', 'DOC-4b498970'],
  },
  {
    ref: 'wp-precistec-contracts',
    type: 'create_work_package',
    actor: 'jean.philippe.garnier',
    ...PRECISTEC,
    area: 'contrats/',
    classification: 'confidential',
    reason: 'Review of the inherited contracts',
    payload: {
      project_id: '@rec:prj-precistec',
      title: 'Revue des contrats hérités (sanctions, changement de contrôle)',
      scope_statement:
        'Revoir les 25 contrats hérités : sanctions, conformité, clauses de changement de contrôle.',
      acceptance_criterion:
        'Chaque contrat classé et une décision enregistrée pour chaque contrat à risque.',
    },
  },
  {
    ref: 'prj-nusafe',
    type: 'create_initiative',
    actor: 'benoit.charrier',
    entity: 'veracier_energie',
    area: 'qualite/',
    classification: 'internal',
    reason: 'RCC-M qualification of the NuSafe VP-200 (ENRG-01)',
    payload: {
      title: 'Qualification RCC-M de la NuSafe VP-200',
      project_code: 'VER-ENR-2025-03',
      objective: 'Constituer le dossier de qualification RCC-M complet de la vanne NuSafe VP-200.',
      sponsor_id: '@person:gilles.perrin',
    },
  },
  {
    ref: 'prj-ah100-fai',
    type: 'create_initiative',
    actor: 'amina.el.fassi',
    ...MAROC,
    area: 'qualite/',
    classification: 'internal',
    reason: 'First article inspection of the AH-100-G2 harness (MAROC-01)',
    payload: {
      title: 'FAI AeroHarness AH-100-G2 selon EN 9102',
      project_code: 'VER-MA-2025-02',
      objective: 'Premier article AH-100-G2 approuvé par Aeronord pour le lancement série.',
      sponsor_id: '@person:rachid.benali',
    },
    evidence: ['DOC-98fe83f3'],
  },

  // ── Controlled documents: policies whose content is their extracted text ──────────────
  ...[
    [
      'cd-incident-policy',
      'DOC-06999ef5',
      'policy',
      'VER-POL-SEC-004',
      'marc.lefevre',
      'restricted',
      'securite/',
    ],
    [
      'cd-telework',
      'DOC-c7009b9a',
      'policy',
      'VER-POL-RH-012',
      'nathalie.verdier',
      'confidential',
      'rh/',
    ],
    [
      'cd-fire-training',
      'DOC-a41743ed',
      'procedure',
      'VER-PRO-HSE-007',
      'karim.hadj.ali',
      'internal',
      'formation/',
    ],
  ].map(([key, doc, cls, number, actor, classification, area]) => ({
    ref: key,
    type: 'submit_document_for_review',
    actor,
    ...SA,
    area,
    classification,
    reason: `${number} brought under document control from the migrated estate`,
    payload: {
      title: `${number} — @title:${doc}`,
      document_class: cls,
      document_number: number,
      revision: 'A',
      owning_role: 'quality_authority',
      content_version: `@textversion:${doc}`,
    },
    evidence: [doc],
  })),

  // ── Decisions ─────────────────────────────────────────────────────────────────────────
  {
    ref: 'dec-severneft',
    type: 'propose_decision',
    actor: 'jean.philippe.garnier',
    ...PRECISTEC,
    area: 'contrats/',
    classification: 'confidential',
    reason: 'Suspension of the Severneft supply contract pending the sanctions review',
    payload: { title: 'Suspendre le contrat d’approvisionnement Severneft hérité de Précis-Tec' },
    evidence: ['DOC-a28fc9ca'],
  },
  {
    ref: 'dec-severneft-accepted',
    type: 'accept_decision',
    actor: 'helene.daubrac',
    ...PRECISTEC,
    area: 'contrats/',
    classification: 'confidential',
    reason: 'Accepted: the contract is suspended until the sanctions review concludes',
    targets: ['@rec:dec-severneft'],
    creates: false,
    payload: {},
  },
  {
    ref: 'dec-second-source',
    type: 'propose_decision',
    actor: 'isabelle.roche',
    ...SA,
    area: 'rapports/achats/',
    classification: 'internal',
    reason: 'Proposed response to the Forges Martelliere receivership',
    payload: { title: 'Qualifier Aciéries de Savoie en second source des forgés TA6V' },
    evidence: ['DOC-29949d76', 'DOC-7823658d'],
  },

  // ── Observations: things people noticed and wrote down ───────────────────────────────
  {
    ref: 'obs-crimping',
    type: 'record_observation',
    actor: 'youssef.amrani',
    ...MAROC,
    area: 'production/',
    classification: 'internal',
    reason: 'captured on the shop floor',
    payload: {
      body: 'Poste 4 câblage : sertissage hors tolérance sur 3 faisceaux AH-100-G2 en début de poste. Pince recalibrée, faisceaux isolés en zone rouge. À surveiller sur l’équipe de nuit.',
      subjects: ['@rec:ps-ah100'],
      tags: ['atelier', 'ah-100'],
    },
  },
  {
    ref: 'obs-reamer',
    type: 'record_observation',
    actor: 'mathieu.roux',
    ...AERO,
    area: 'production/',
    classification: 'internal',
    reason: 'captured at Op.60',
    payload: {
      body: 'Op.60 : usure de la fraise d’alésage port B visible dès 180 pièces sur la série en cours — cohérent avec le passage à 200 pièces décidé après NC-0312-001.',
      subjects: ['@rec:nc-0312-001'],
      tags: ['usinage', 'av-3000'],
    },
  },
  {
    ref: 'obs-britannic',
    type: 'record_observation',
    actor: 'claire.fontaine',
    ...SA,
    area: 'contrats/client/',
    classification: 'internal',
    reason: 'captured after a customer call',
    payload: {
      body: 'Britannic Aerospace demande une offre pour 40 AV-3000 supplémentaires livrables en 2026 ; à croiser avec le plan de charge Toulouse avant de répondre.',
      subjects: ['@rec:ps-av3000'],
      tags: ['commercial'],
    },
  },
  {
    ref: 'obs-savoie-audit',
    type: 'record_observation',
    actor: 'karim.hadj.ali',
    ...SA,
    area: 'qualite/',
    classification: 'internal',
    reason: 'captured after the supplier audit',
    payload: {
      body: 'Visite Aciéries de Savoie : presse de forge équipée de mesure laser, SPC en place. Candidat crédible au second source TA6V si le FAI est conforme.',
      subjects: ['@rec:wp-second-source'],
      tags: ['fournisseur'],
    },
  },
];
