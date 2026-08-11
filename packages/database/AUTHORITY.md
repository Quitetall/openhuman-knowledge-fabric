# @kf/database

The only package permitted to open a PostgreSQL connection. Everything else receives a
transaction handle.

Authority: PostgreSQL is the constitutional kernel (directive §2.2). This package is its
access boundary, not its owner.
