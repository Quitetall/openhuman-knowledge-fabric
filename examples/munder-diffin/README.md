# Munder Diffin Paper Shredding Co. — master records

Every file here was written by `kf master-record` on the dogfood host, as the person named,
through the API, byte for byte as returned: `<user>.html`, `<user>.md`, `<user>.json` are the
`master_sections` projection of that person's compiled master record; the `.log` beside each is
what the command printed (compile status, corpus digest, projection digest).

Produced by `fixtures/munder-diffin/setup.sh` against release `2bc1ba54ee6c` on 2026-09-11.
Nothing in it is hand-edited. The corpus is the 14 documents in `fixtures/munder-diffin/documents`
plus the organization's people, role assignments and clearances. Open any `.html` in a browser:
it carries its own styles, links every member to its Object View and every document to its bytes,
and fetches nothing.

| person            | role                | clearance    | role ceiling | members |
| ----------------- | ------------------- | ------------ | ------------ | ------- |
| Jim Miller        | project_owner       | restricted   | —            | 33      |
| Hank Shredder     | technical_authority | restricted   | —            | 33      |
| Dwight Blunt      | work_order_manager  | confidential | —            | 31      |
| Karen Filo        | finance_approver    | confidential | —            | 31      |
| Toby Flint        | quality_authority   | confidential | —            | 31      |
| Pam Bealey        | performer           | internal     | —            | 28      |
| Ryan Temp         | performer           | internal     | —            | 28      |
| Bob Vance         | customer_contact    | confidential | public       | 15      |
| Robert California | partner_contact     | confidential | internal     | 29      |

The two contacts are the point of the model (ADR 0027). Bob Vance's role reaches the
organization's public records; an object-scoped grant reaches his own service agreement, which
is confidential; the pricing sheet, also confidential, is not in his record. Robert California's
role reaches internal records; his grant reaches the partner integration spec; the pricing sheet
is not in his either.
