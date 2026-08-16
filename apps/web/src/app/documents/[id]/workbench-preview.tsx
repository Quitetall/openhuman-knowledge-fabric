import type { ReactNode } from 'react';
import type { ParsedBlock } from './workbench-types';

function Block({ block }: { readonly block: ParsedBlock }) {
  const id = `parsed-block-${block.ordinal}`;
  const headingStyle = { marginTop: '2rem', marginBottom: '0.5rem', scrollMarginTop: '1rem' };
  if (block.kind === 'heading') {
    const sourceLevel = block.level ?? 1;
    if (sourceLevel <= 1) {
      return (
        <h2 id={id} tabIndex={-1} style={headingStyle}>
          {block.text}
        </h2>
      );
    }
    if (sourceLevel === 2) {
      return (
        <h3 id={id} tabIndex={-1} style={headingStyle}>
          {block.text}
        </h3>
      );
    }
    if (sourceLevel === 3) {
      return (
        <h4 id={id} tabIndex={-1} style={headingStyle}>
          {block.text}
        </h4>
      );
    }
    if (sourceLevel === 4) {
      return (
        <h5 id={id} tabIndex={-1} style={headingStyle}>
          {block.text}
        </h5>
      );
    }
    if (sourceLevel === 5) {
      return (
        <h6 id={id} tabIndex={-1} style={headingStyle}>
          {block.text}
        </h6>
      );
    }
    return (
      <div
        id={id}
        role="heading"
        aria-level={sourceLevel + 1}
        tabIndex={-1}
        style={{ ...headingStyle, fontSize: '0.8rem', fontWeight: 700 }}
      >
        {block.text}
      </div>
    );
  }
  if (block.kind === 'paragraph') return <p id={id}>{block.text}</p>;
  if (block.kind === 'list_item') return null;
  if (block.kind === 'quote') {
    return (
      <blockquote
        id={id}
        style={{ borderLeft: '3px solid #94a3b8', marginLeft: 0, paddingLeft: '1rem' }}
      >
        {block.text}
      </blockquote>
    );
  }
  if (block.kind === 'horizontal_rule') return <hr id={id} />;
  return (
    <pre id={id} style={{ whiteSpace: 'pre-wrap', background: '#f8fafc', padding: '0.85rem' }}>
      {block.text}
    </pre>
  );
}

function ParsedList({ blocks }: { readonly blocks: readonly ParsedBlock[] }) {
  const ordered = blocks[0]?.attributes['list'] === 'ordered';
  const items = blocks.map((block) => {
    const order = block.attributes['order'];
    return (
      <li
        key={block.ordinal}
        id={`parsed-block-${block.ordinal}`}
        value={ordered && typeof order === 'number' ? order : undefined}
        style={{ margin: '0.35rem 0' }}
      >
        {block.text}
      </li>
    );
  });
  if (ordered) {
    const firstOrder = blocks[0]?.attributes['order'];
    return <ol start={typeof firstOrder === 'number' ? firstOrder : undefined}>{items}</ol>;
  }
  return <ul>{items}</ul>;
}

function PreviewBlocks({ parsedBlocks }: { readonly parsedBlocks: readonly ParsedBlock[] }) {
  const rendered: ReactNode[] = [];
  let index = 0;
  while (index < parsedBlocks.length) {
    const block = parsedBlocks[index]!;
    if (block.kind !== 'list_item') {
      rendered.push(<Block key={block.ordinal} block={block} />);
      index += 1;
      continue;
    }
    const listKind = block.attributes['list'] === 'ordered' ? 'ordered' : 'bullet';
    const grouped: ParsedBlock[] = [];
    while (index < parsedBlocks.length) {
      const candidate = parsedBlocks[index]!;
      const candidateKind = candidate.attributes['list'] === 'ordered' ? 'ordered' : 'bullet';
      if (candidate.kind !== 'list_item' || candidateKind !== listKind) break;
      grouped.push(candidate);
      index += 1;
    }
    rendered.push(<ParsedList key={`list-${grouped[0]!.ordinal}`} blocks={grouped} />);
  }
  return rendered;
}

export function PreviewPanel({ parsedBlocks }: { readonly parsedBlocks: readonly ParsedBlock[] }) {
  return (
    <article style={{ maxWidth: '52rem', fontFamily: 'ui-serif, Georgia, serif', lineHeight: 1.7 }}>
      {parsedBlocks.length === 0 ? (
        <p>No machine-parsed preview is available.</p>
      ) : (
        <PreviewBlocks parsedBlocks={parsedBlocks} />
      )}
    </article>
  );
}
