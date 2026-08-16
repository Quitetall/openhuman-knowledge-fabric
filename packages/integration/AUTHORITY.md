# @kf/integration

Adapters and dispatcher-bound effects for systems that own their own facts —
openhuman-quality, LamQuant, accounting. Records external identity, revision and
digest; never copies the fact.

Authority: none, by construction. Integration code does not create independent
write authority. Controlled writes are package-internal effects executed only
inside the core typed-action dispatcher transaction; a raw mutation exported
from the package root is a defect (§2.1).
