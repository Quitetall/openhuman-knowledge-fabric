# @kf/actions

Implements `executeAction`. Every controlled state transition passes through here, in one
database transaction, with authority resolution, precondition checks, audit and outbox.

Authority: owns the transition, never the fact. No controlled write may bypass this package
(directive §2.6, §10).
