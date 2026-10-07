-- migrate:up

-- ADR 0040 decision 3 (KF-SAS-RQ-267, RQ-268): the living organization overview is an ordinary
-- record, `organization_overview`, granted like any other. Its type, states and acts come from the
-- ontology seed; what it says is generated per reader by the `organization_overview` projection
-- and never stored, so it carries no typed row.
--
-- One active overview per organization. Two would leave a dashboard choosing between them, and
-- "the overview" would mean whichever one a query happened to return first. A new overview is
-- declared after the old one is retired; the old one stays, retired, as the record of what the
-- organization's overview was.
create unique index object_one_active_organization_overview
  on core.object (organization_id)
  where object_type = 'organization_overview' and lifecycle_state = 'active';

-- migrate:down

drop index if exists core.object_one_active_organization_overview;
