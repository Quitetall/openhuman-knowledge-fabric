// RFC 4180 CSV → array of objects keyed by the header row. Quoted fields may hold commas,
// doubled quotes and newlines. Throws on an unterminated quote or a row whose width differs
// from the header, rather than guessing.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.replace(/^\uFEFF/, '');
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
    i += 1;
  }
  if (quoted) throw new Error('unterminated quoted field');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((cells, n) => {
    if (cells.length !== header.length) {
      throw new Error(`row ${n + 2} has ${cells.length} fields, header has ${header.length}`);
    }
    return Object.fromEntries(header.map((h, k) => [h, cells[k]]));
  });
}
