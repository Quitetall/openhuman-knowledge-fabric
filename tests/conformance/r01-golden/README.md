# OpenHuman Knowledge Fabric schema pack

Version: `1.0.0-draft.1`  
Status: Draft companion to `OH-DOC-000002-1-R01`  

This package contains the machine-readable representation of the Organizational Graph and Work Control Specification.

Files:

- `knowledge-fabric.schema.json` — JSON Schema Draft 2020-12 graph envelope and typed nodes.
- `knowledge-fabric.vocabulary.json` — controlled node, edge, action, authority and invariant vocabulary.
- `knowledge-fabric.state-machines.json` — allowed lifecycle transitions.
- `knowledge-fabric.context.jsonld` — JSON-LD context and W3C PROV mapping.
- `knowledge-fabric.shacl.ttl` — SHACL constraint subset for graph validation.
- `knowledge-fabric.work-control.bpmn` — BPMN 2.0 interchange representation of the primary workflow.
- `example-atlas-enclosure-project.json` — complete worked graph example.
- `validate_graph.py` — portable JSON Schema, referential-integrity and financial-invariant validator.
- `manifest.json` — file hashes for this package.

Run:

```bash
python validate_graph.py example-atlas-enclosure-project.json
```

The DOCX is the controlled human-readable specification. These files are the normative machine-readable companion only after approval and release together under a recorded release manifest.
