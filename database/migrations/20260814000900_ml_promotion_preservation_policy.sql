-- migrate:up

-- Early dogfood applied the ML registry before promotion preservation policies were added
-- to its source migration. Converge those databases forward instead of relying on edits to an
-- already-recorded migration. Auditor and backup roles need cross-organization SELECT access
-- to preserve signed promotion history; neither role receives mutation authority.
drop policy if exists promotion_receipt_privileged on ml.promotion_receipt;
create policy promotion_receipt_privileged on ml.promotion_receipt
  for select to kf_auditor, kf_backup using (true);

drop policy if exists promotion_receipt_evidence_privileged
  on ml.promotion_receipt_evidence;
create policy promotion_receipt_evidence_privileged on ml.promotion_receipt_evidence
  for select to kf_auditor, kf_backup using (true);

drop policy if exists promotion_revocation_privileged on ml.promotion_revocation;
create policy promotion_revocation_privileged on ml.promotion_revocation
  for select to kf_auditor, kf_backup using (true);

-- migrate:down

drop policy if exists promotion_revocation_privileged on ml.promotion_revocation;
drop policy if exists promotion_receipt_evidence_privileged
  on ml.promotion_receipt_evidence;
drop policy if exists promotion_receipt_privileged on ml.promotion_receipt;
