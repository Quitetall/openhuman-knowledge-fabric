/** Reduce only the directives this verifier inspects; this is not a general systemd parser. */
export function commissioningDirectives(text: string): readonly [string, string][] {
  const lists = new Set([
    'EnvironmentFile',
    'LoadCredential',
    'LoadCredentialEncrypted',
    'ExecStart',
    'ExecStartPre',
    'ExecStartPost',
    'ExecStop',
    'ExecStopPost',
    'ExecReload',
    'ExecCondition',
    'OnFailure',
  ]);
  const declarations = new Map<string, string[]>();
  const environment = new Map<string, string>();
  let section = '';
  const logical = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  for (const line of logical) {
    if (/^\s*[#;]/.test(line)) continue;
    const heading = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    const match = /^\s*([A-Za-z]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!,
      value = match[2]!.trim();
    if (section !== (key === 'OnFailure' ? 'Unit' : 'Service')) continue;
    if (key === 'Environment') {
      if (!value) environment.clear();
      // The reviewed units use assignments, not expansion. Quotes may surround a whole
      // assignment; values are never executed or included in a refusal.
      else
        for (const token of value.match(/(?:[^\s"'\\]|\\.|"[^"]*"|'[^']*')+/g) ?? []) {
          const plain = /^("|')([\s\S]*)\1$/.exec(token)?.[2] ?? token;
          const separator = plain.indexOf('=');
          if (separator > 0) environment.set(plain.slice(0, separator), plain.slice(separator + 1));
        }
    } else if (lists.has(key)) {
      if (!value) declarations.set(key, []);
      else declarations.set(key, [...(declarations.get(key) ?? []), value]);
    } else declarations.set(key, value ? [value] : []);
  }
  return [...declarations.entries()]
    .flatMap(([key, values]) => values.map((value) => [key, value] as [string, string]))
    .concat([...environment.entries()].map(([key, value]) => ['Environment', `${key}=${value}`]));
}
