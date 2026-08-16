import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import DocumentError from './error.js';

function descendants(node: ReactNode): ReactElement[] {
  if (!isValidElement(node)) return [];
  const element = node as ReactElement<{ readonly children?: ReactNode }>;
  return [
    element,
    ...Children.toArray(element.props.children).flatMap((child) => descendants(child)),
  ];
}

describe('document error boundary', () => {
  it('shows generic recovery controls without leaking error details', () => {
    const retry = vi.fn();
    const error = Object.assign(new Error('secret upstream response'), {
      digest: 'private-next-error-digest',
    });
    const element = createElement(DocumentError, { error, retry });
    const html = renderToStaticMarkup(element);
    const button = descendants(DocumentError({ error, retry })).find(
      (candidate) => candidate.type === 'button',
    );

    expect(html).toContain('Document unavailable');
    expect(html).toContain('Try again');
    expect(html).toContain('href="/documents"');
    expect(html).not.toContain(error.message);
    expect(html).not.toContain(error.digest);
    expect(button?.props).toMatchObject({ type: 'button', onClick: retry });
  });
});
