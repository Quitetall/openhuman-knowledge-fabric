# Munder Diffin Paper Shredding Co. — master records

Every file here was written by `kf master-record` on the dogfood host, as the person named,
through the API, byte for byte as returned: `<user>.html`, `<user>.md`, `<user>.json` are the
`master_sections` projection of that person's compiled master record; the `.log` beside each is
what the command printed (compile status, corpus digest, projection digest).

Produced by `fixtures/munder-diffin/setup.sh` against release `bc1645e0526e` on 2026-09-11.
Nothing in it is hand-edited. The corpus is the 14 documents in `fixtures/munder-diffin/documents`
plus the organization's people, role assignments and clearances.

| person            | role                | asked at     | members |
| ----------------- | ------------------- | ------------ | ------- |
| Jim Miller        | project_owner       | restricted   | 33      |
| Hank Shredder     | technical_authority | restricted   | 33      |
| Dwight Blunt      | work_order_manager  | confidential | 31      |
| Karen Filo        | finance_approver    | confidential | 31      |
| Toby Flint        | quality_authority   | confidential | 31      |
| Pam Bealey        | performer           | internal     | 28      |
| Ryan Temp         | performer           | internal     | 28      |
| Bob Vance         | customer_contact    | public       | refused |
| Robert California | partner_contact     | internal     | not run |

**Two records are missing, and the reason is a limit of the model, not of the run.** Bob
Vance's role assignment is capped at `public`; his own person object is classified `internal`,
as every person's is, so at that ceiling the compile act cannot see its own target
(`object_not_visible`). The object-scoped grant to his agreement is recorded and equally out of
reach: the acting role's ceiling caps the whole session. Robert California was not reached
because the run stops at the first refusal. See `bob.vance.html.log`.
