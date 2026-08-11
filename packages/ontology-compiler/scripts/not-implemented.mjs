// Placeholder for the Gate 2 ontology compiler.
//
// Exits non-zero. A stub that exits 0 would let CI, a release pipeline or a person read
// "ontology consistent" from a check that examined nothing — which is exactly the failure
// the consistency gate exists to prevent.
const command = process.argv[2] ?? '<command>';
console.error(
  `@kf/ontology-compiler: '${command}' is not implemented yet (Gate 2).\n` +
    `The ontology under ontology/ and its generated artifacts under generated/ do not exist.\n` +
    `This command exits non-zero deliberately so nothing can record a passing check.`,
);
process.exit(1);
