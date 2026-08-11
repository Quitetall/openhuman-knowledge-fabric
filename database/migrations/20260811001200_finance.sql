-- migrate:up

-- The finance schema, and the three financial invariants as database constraints.
--
-- KF-FIN-001, -002 and -003 are aggregate rules: each compares a new row against a SUM over
-- its siblings. No CHECK constraint can express that, so each is a trigger — and each trigger
-- takes a row lock on the parent first.
--
-- That lock is the whole correctness argument. Without it, two concurrent inserts each read a
-- total that does not yet include the other, both pass, and the ceiling is breached by a
-- transaction pair that individually looked fine. Serialising on the parent row is what makes
-- "the sum stays within the ceiling" true rather than usually true.

create table finance.invoice (
  id              uuid primary key references core.object (id) on delete restrict,
  engagement_id   uuid not null references org.engagement (id) on delete restrict,
  invoice_number  text not null,
  -- Whose invoice number this is. A supplier's numbering is theirs, and two suppliers may
  -- legitimately both issue an "INV-001".
  issuer_id       uuid not null references core.object (id),
  currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),
  issued_on       date not null,
  due_on          date,

  unique (issuer_id, invoice_number),
  constraint invoice_due_after_issue check (due_on is null or due_on >= issued_on)
);

create index invoice_by_engagement on finance.invoice (engagement_id);

create table finance.invoice_line (
  id              uuid primary key default uuidv7(),
  invoice_id      uuid not null references finance.invoice (id) on delete restrict,
  line_no         integer not null check (line_no > 0),
  -- What is being billed for. KF-FIN-002 compares against the value ACCEPTED for this order,
  -- so a line that names no order cannot be checked and is therefore not allowed.
  work_order_id   uuid not null references work.work_order (id) on delete restrict,
  acceptance_id   uuid references work.acceptance_record (id) on delete restrict,
  description     text not null check (length(btrim(description)) between 1 and 2000),
  amount_minor    bigint not null check (amount_minor > 0),

  unique (invoice_id, line_no)
);

create index invoice_line_by_invoice on finance.invoice_line (invoice_id, line_no);
create index invoice_line_by_order on finance.invoice_line (work_order_id);

create table finance.payment (
  id              uuid primary key references core.object (id) on delete restrict,
  payer_id        uuid not null references core.object (id),
  payee_id        uuid not null references core.object (id),
  amount_minor    bigint not null check (amount_minor > 0),
  currency        char(3) not null check (currency ~ '^[A-Z]{3}$'),
  method          text not null check (method in (
    'bank_transfer', 'card', 'marketplace', 'cash', 'other'
  )),
  -- The payment provider's reference. Deliberately NOT bank details: account numbers, tax
  -- identifiers and payroll data never enter this system.
  external_reference text,
  value_date      date not null
);

create table finance.payment_allocation (
  id              uuid primary key default uuidv7(),
  payment_id      uuid not null references finance.payment (id) on delete restrict,
  invoice_id      uuid not null references finance.invoice (id) on delete restrict,
  amount_minor    bigint not null check (amount_minor > 0),

  unique (payment_id, invoice_id)
);

create index allocation_by_payment on finance.payment_allocation (payment_id);
create index allocation_by_invoice on finance.payment_allocation (invoice_id);

-- ── KF-FIN-001 ──────────────────────────────────────────────────────────────────────────
-- Accepted value must not exceed the authorized work-order ceiling without an approved
-- amendment.

create or replace function work.assert_accepted_within_ceiling() returns trigger
language plpgsql
as $$
declare
  v_order        record;
  v_amendments   bigint;
  v_accepted     bigint;
  v_currency     char(3);
begin
  select wo.id, wo.ceiling_minor, wo.currency, wo.order_number
    into v_order
    from work.work_order wo
    join work.work_execution we on we.work_order_id = wo.id
   where we.id = new.work_execution_id
     -- The lock that makes the sum below trustworthy under concurrency.
     for update of wo;

  if not found then
    raise exception 'work execution % has no work order', new.work_execution_id;
  end if;

  -- Currency first. Comparing 500 USD against a 400 EUR ceiling is not a comparison.
  select we.currency into v_currency from work.work_execution we where we.id = new.work_execution_id;
  if new.currency <> v_order.currency or v_currency <> v_order.currency then
    raise exception 'KF-FIN-001: currency mismatch — acceptance %, execution %, work order %',
      new.currency, v_currency, v_order.currency
      using errcode = 'check_violation';
  end if;

  -- Only APPROVED amendments raise a ceiling. An amendment awaiting approval is a request.
  select coalesce(sum(a.ceiling_delta_minor), 0) into v_amendments
    from work.work_order_amendment a
   where a.work_order_id = v_order.id
     and a.approved_at is not null
     and a.currency = v_order.currency;

  select coalesce(sum(ar.accepted_value_minor), 0) into v_accepted
    from work.acceptance_record ar
    join work.work_execution we on we.id = ar.work_execution_id
   where we.work_order_id = v_order.id
     and ar.id <> new.id;

  if v_accepted + new.accepted_value_minor > v_order.ceiling_minor + v_amendments then
    raise exception
      'KF-FIN-001: accepted value %.2f would exceed work order % ceiling %.2f (amended by %.2f); '
      'raise the ceiling with an approved amendment first',
      (v_accepted + new.accepted_value_minor) / 100.0,
      v_order.order_number,
      v_order.ceiling_minor / 100.0,
      v_amendments / 100.0
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

create trigger acceptance_within_ceiling
  before insert on work.acceptance_record
  for each row execute function work.assert_accepted_within_ceiling();

-- ── KF-FIN-002 ──────────────────────────────────────────────────────────────────────────
-- Invoice line value must not exceed the accepted value still available for that work order.

create or replace function finance.assert_line_within_accepted() returns trigger
language plpgsql
as $$
declare
  v_order      record;
  v_invoice    record;
  v_accepted   bigint;
  v_invoiced   bigint;
begin
  select wo.id, wo.currency, wo.order_number into v_order
    from work.work_order wo
   where wo.id = new.work_order_id
     for update;

  select i.currency into v_invoice from finance.invoice i where i.id = new.invoice_id;

  if v_invoice.currency <> v_order.currency then
    raise exception 'KF-FIN-002: invoice currency % does not match work order currency %',
      v_invoice.currency, v_order.currency
      using errcode = 'check_violation';
  end if;

  -- Only accepted or partially-accepted work can be billed. Rejected work carries zero
  -- accepted value, so it fails this check by arithmetic rather than by a special case.
  select coalesce(sum(ar.accepted_value_minor), 0) into v_accepted
    from work.acceptance_record ar
    join work.work_execution we on we.id = ar.work_execution_id
   where we.work_order_id = v_order.id;

  select coalesce(sum(il.amount_minor), 0) into v_invoiced
    from finance.invoice_line il
   where il.work_order_id = v_order.id
     and il.id <> new.id;

  if v_invoiced + new.amount_minor > v_accepted then
    raise exception
      'KF-FIN-002: invoicing %.2f against work order % would exceed accepted value %.2f '
      '(already invoiced %.2f)',
      new.amount_minor / 100.0, v_order.order_number,
      v_accepted / 100.0, v_invoiced / 100.0
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

create trigger invoice_line_within_accepted
  before insert on finance.invoice_line
  for each row execute function finance.assert_line_within_accepted();

-- ── KF-FIN-003 ──────────────────────────────────────────────────────────────────────────
-- Payment allocations must sum to no more than the payment amount, and must not exceed
-- invoice balances. Two independent over-allocations, both of which end with money recorded
-- that does not exist.

create or replace function finance.assert_allocation_within_bounds() returns trigger
language plpgsql
as $$
declare
  v_payment      record;
  v_invoice      record;
  v_allocated    bigint;
  v_invoice_total bigint;
  v_invoice_paid bigint;
begin
  select p.id, p.amount_minor, p.currency into v_payment
    from finance.payment p where p.id = new.payment_id for update;

  select i.id, i.currency, i.invoice_number into v_invoice
    from finance.invoice i where i.id = new.invoice_id for update;

  if v_payment.currency <> v_invoice.currency then
    raise exception 'KF-FIN-003: payment currency % does not match invoice currency %',
      v_payment.currency, v_invoice.currency
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(pa.amount_minor), 0) into v_allocated
    from finance.payment_allocation pa
   where pa.payment_id = v_payment.id and pa.id <> new.id;

  if v_allocated + new.amount_minor > v_payment.amount_minor then
    raise exception
      'KF-FIN-003: allocations would total %.2f against a payment of %.2f',
      (v_allocated + new.amount_minor) / 100.0, v_payment.amount_minor / 100.0
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(il.amount_minor), 0) into v_invoice_total
    from finance.invoice_line il where il.invoice_id = v_invoice.id;

  select coalesce(sum(pa.amount_minor), 0) into v_invoice_paid
    from finance.payment_allocation pa
   where pa.invoice_id = v_invoice.id and pa.id <> new.id;

  if v_invoice_paid + new.amount_minor > v_invoice_total then
    raise exception
      'KF-FIN-003: allocating %.2f to invoice % would overpay it — total %.2f, already allocated %.2f',
      new.amount_minor / 100.0, v_invoice.invoice_number,
      v_invoice_total / 100.0, v_invoice_paid / 100.0
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

create trigger allocation_within_bounds
  before insert on finance.payment_allocation
  for each row execute function finance.assert_allocation_within_bounds();

-- migrate:down

drop trigger allocation_within_bounds on finance.payment_allocation;
drop function finance.assert_allocation_within_bounds();
drop trigger invoice_line_within_accepted on finance.invoice_line;
drop function finance.assert_line_within_accepted();
drop trigger acceptance_within_ceiling on work.acceptance_record;
drop function work.assert_accepted_within_ceiling();
drop table finance.payment_allocation;
drop table finance.payment;
drop table finance.invoice_line;
drop table finance.invoice;
