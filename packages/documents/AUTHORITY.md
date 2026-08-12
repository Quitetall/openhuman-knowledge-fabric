# @kf/documents

Parses verified document bytes into ordered, independently digested atoms and supplies draft
controlled-document action atoms plus read projections.

Authority: owns no source fact. Object storage owns source bytes; PostgreSQL owns artifact,
document, lifecycle and provenance facts. Parsed atoms are disposable projections.
