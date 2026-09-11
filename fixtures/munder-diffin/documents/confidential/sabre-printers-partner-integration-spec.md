# Sabre Printers Partner Integration Spec

**Classification:** Confidential — Executive, Finance, and Sabre Printers
Inc. (for their own agreement)
**Owner:** Jim Miller (relationship), Karen Filo (financial terms)
**Partner contact:** Robert California, Sabre Printers Inc.
(robert.california@sabreprinters.example)
**Effective:** February 1, 2026 | **Renewal:** Annual, each January 31

## Background

Sabre Printers Inc. is a regional print shop that resells Munder Diffin
shredding services to its own commercial printing customers as an
add-on, primarily targeting print-run overage destruction and general
office document purges. This spec defines how referrals are handed off,
how referral fees are calculated, what data is exchanged, and the service
levels both parties commit to.

## Referral Model

1. Sabre Printers offers Munder Diffin shredding as a co-branded add-on
   to its own customers ("Sabre Shred, powered by Munder Diffin").
2. Sabre does not perform any destruction itself; every job is fulfilled
   by Munder Diffin under our standard chain-of-custody procedures.
3. Sabre invoices its own customer directly for the shredding line item;
   Munder Diffin invoices Sabre at the wholesale referral rate.

## Referral Fees

- Munder Diffin bills Sabre Printers at approximately **18% below
  standard list price** (see Q3 2026 Pricing and Margin Sheet), which
  functions as Sabre's margin on the referred service.
- Sabre Printers sets its own customer-facing price; Munder Diffin has no
  visibility into, or control over, Sabre's markup.
- Referral volume is reconciled monthly; Robert California receives a
  volume summary from Karen Filo's office by the 5th business day of the
  following month.
- Any change to the 18% referral rate requires Karen Filo's written
  approval and a signed amendment to the partner agreement.

## Order Handoff

1. A Sabre customer requests shredding through Sabre's ordering system.
2. Sabre submits the job to Munder Diffin via the partner order form
   (email to partners@munderdiffin.example, cc'd to Pam Bealey's team),
   including the fields listed below.
3. Munder Diffin's Customer Success team schedules the job as it would
   any direct customer request, using Sabre's referral account number
   for billing.
4. The Certificate of Destruction is issued in the **end customer's**
   name and sent to Sabre, who forwards it to their customer.

## Data Exchange Fields

Each partner order must include:

| Field                 | Description                                                 |
| --------------------- | ----------------------------------------------------------- |
| `sabre_order_id`      | Sabre's internal order reference                            |
| `end_customer_name`   | Name to appear on the Certificate of Destruction            |
| `service_address`     | Pickup or delivery address                                  |
| `service_type`        | On-Demand Purge, Scheduled Route, or Hard Drive Destruction |
| `estimated_volume`    | Boxes, lb, or drive count                                   |
| `requested_date`      | Preferred service date                                      |
| `referral_account_no` | Sabre's Munder Diffin billing account                       |

Munder Diffin does not share end-customer contact information back to
Sabre beyond what Sabre itself submitted; Sabre remains the primary
relationship owner for its own customers.

## Service Level Agreement

- Referred jobs are scheduled within the same turnaround windows as
  direct Munder Diffin business (see Service Overview): 3–5 business days
  for On-Demand Purge, standard route cadence for Scheduled Route.
- Munder Diffin commits to a 95% on-time pickup rate for referred jobs,
  measured quarterly and reported to Robert California.
- Certificates of Destruction are delivered to Sabre within 2 business
  days of job completion, matching our standard customer commitment.
- Escalations (missed pickup, custody exception) affecting a Sabre
  referral are routed to Dwight Blunt with a copy to Robert California
  within 24 hours.

## Confidentiality

Pricing terms in this document, including the referral rate, are
confidential to Munder Diffin executive leadership, Finance, and Sabre
Printers Inc. Sabre Printers must not disclose the wholesale referral
rate to its own customers.

## Review

This agreement is reviewed annually by Jim Miller and Karen Filo ahead of
the January 31 renewal date; Robert California is Sabre's signing contact
for any amendment.
