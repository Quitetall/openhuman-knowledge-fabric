import { formatState } from '@kf/ui';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { DocumentDetail, DocumentWorkspace, WorkspaceHolder } from '../../../lib/api';
import { DigestDisclosure } from '../../components/digest-disclosure';
import { documentProvenanceView } from './workbench-provenance';
import type { ParsedBlock } from './workbench-types';

function Definition({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div>
      <dt style={{ color: '#64748b', fontSize: '0.78rem' }}>{label}</dt>
      <dd style={{ margin: '0 0 0.75rem', overflowWrap: 'anywhere' }}>{value}</dd>
    </div>
  );
}

export function SourcePanel({ document }: { readonly document: DocumentDetail }) {
  return (
    <div style={{ maxWidth: '48rem' }}>
      <h2>Verified source</h2>
      <dl>
        <Definition
          label="Content artifact version"
          value={document.contentVersionId ?? 'not recorded'}
        />
        <Definition label="Media type" value={document.mediaType ?? 'not recorded'} />
        <Definition
          label="Size"
          value={document.sizeBytes === null ? 'not recorded' : `${document.sizeBytes} bytes`}
        />
        <Definition label="SHA-256" value={document.sha256 ?? 'not recorded'} />
      </dl>
      {document.contentVersionId === null ? (
        <button type="button" className="kf-button" disabled>
          No fabric source bytes recorded
        </button>
      ) : (
        <a
          href={`/documents/${encodeURIComponent(document.id)}/source`}
          className="kf-button"
          download
        >
          Download verified source
        </a>
      )}
      <p style={{ color: '#64748b' }}>
        The server retrieves the recorded immutable storage version and verifies size and SHA-256
        before streaming it. Legacy or inconsistent storage claims fail closed.
      </p>
    </div>
  );
}

export function OutlinePanel({
  headings,
  onShowHeading,
}: {
  readonly headings: readonly ParsedBlock[];
  readonly onShowHeading: (ordinal: number) => void;
}) {
  return (
    <div>
      <h2>Composed outline</h2>
      {headings.length === 0 ? (
        <p>No heading Parsed Blocks.</p>
      ) : (
        <ol>
          {headings.map((heading) => (
            <li
              key={heading.ordinal}
              style={{ marginLeft: `${Math.max(0, (heading.level ?? 1) - 1)}rem` }}
            >
              <button
                type="button"
                onClick={() => onShowHeading(heading.ordinal)}
                style={{
                  border: 0,
                  background: 'transparent',
                  color: '#0f766e',
                  cursor: 'pointer',
                  padding: '0.2rem 0',
                  textAlign: 'left',
                  textDecoration: 'underline',
                }}
              >
                {heading.text}{' '}
                <small style={{ color: '#64748b' }}>Parsed Block {heading.ordinal}</small>
              </button>
            </li>
          ))}
        </ol>
      )}
      <h3>Structured navigation coverage</h3>
      <ul>
        <li>Parsed Block outline: available above from the retained parser projection.</li>
        <li>
          Composition inputs, backlinks, ADR links, and traceability links are exposed on the
          Composition and Navigation tabs from typed repository records.
        </li>
        <li>
          <Link href="/search">Classification-aware canonical search</Link>: results are limited by
          the selected organization and the caller&apos;s classification ceiling.
        </li>
      </ul>
    </div>
  );
}

function WorkspaceHolderPanel({ holder }: { readonly holder: WorkspaceHolder }) {
  if (holder.kind === 'git') {
    return (
      <dl>
        <Definition label="Holder kind" value="git" />
        <Definition label="Holder record" value={holder.id} />
        <Definition label="Repository" value={holder.repository} />
        <Definition label="Commit" value={holder.commitSha} />
        <Definition label="Path" value={holder.path} />
        <Definition label="Submodule commit" value={holder.submoduleCommitSha ?? 'not recorded'} />
        <Definition label="Content digest" value={holder.contentDigest} />
      </dl>
    );
  }
  if (holder.kind === 'external') {
    return (
      <dl>
        <Definition label="Holder kind" value="external" />
        <Definition label="Holder record" value={holder.id} />
        <Definition label="Authority" value={holder.authority} />
        <Definition label="Revision" value={holder.revision} />
        <Definition label="Content digest" value={holder.contentDigest} />
      </dl>
    );
  }
  return (
    <dl>
      <Definition label="Holder kind" value="fabric_native" />
      <Definition label="Holder record" value={holder.id} />
      <Definition label="Artifact version" value={holder.artifactVersionId} />
      <Definition label="Content digest" value={holder.contentDigest} />
      <Definition label="Media type" value={holder.mediaType ?? 'not recorded'} />
    </dl>
  );
}

export function ProvenancePanel({
  document,
  workspace,
}: {
  readonly document: DocumentDetail;
  readonly workspace: DocumentWorkspace;
}) {
  const source = documentProvenanceView(document);
  return (
    <div>
      <h2>Provenance and digests</h2>
      <dl>
        <Definition label="Source SHA-256" value={document.sha256 ?? 'not recorded'} />
        <Definition
          label="Parsed content digest"
          value={document.contentDigest ?? 'not recorded'}
        />
        <Definition
          label="Parser"
          value={`${document.parser ?? 'none'} ${document.parserVersion ?? ''}`.trim()}
        />
        <Definition
          label="Projection contract"
          value={document.projectionContract ?? 'not recorded'}
        />
      </dl>

      <h3>Workspace subject</h3>
      {workspace.status === 'ready' ? (
        <div className="kf-responsive-grid">
          <div>
            <h4>Subject</h4>
            <dl>
              <Definition label="Object" value={workspace.target.objectId} />
              <Definition label="Stable key" value={workspace.target.stableKey} />
              <Definition label="Kind" value={formatState(workspace.target.kind)} />
              <Definition label="Document policy" value={workspace.target.documentPolicy} />
            </dl>
          </div>
          <div>
            <h4>Current Holder</h4>
            <WorkspaceHolderPanel holder={workspace.target.holder} />
          </div>
        </div>
      ) : (
        <p className="kf-status kf-status-warning" role="status">
          Workspace Holder metadata requires one visible finalized Basis.
        </p>
      )}

      <h3>Authored source authority</h3>
      {source.status === 'recorded' ? (
        <div className="kf-responsive-grid">
          <div>
            <h4>Source subject</h4>
            <dl>
              <Definition label="Stable key" value={source.stableKey} />
              <Definition label="Fragment" value={source.fragmentId} />
              <Definition label="Document policy" value={source.documentPolicy} />
            </dl>
          </div>
          <div>
            <h4>Source Holder</h4>
            <dl>
              <Definition label="Holder kind" value={source.holder.kind} />
              <Definition label="Holder record" value={source.holder.id} />
              <Definition label="Recorded at" value={source.holder.recordedAt} />
              <Definition label="Recorded by action" value={source.holder.recordedByAction} />
            </dl>
          </div>
          <div>
            <h4>Source revision</h4>
            <dl>
              <Definition label="Fragment revision" value={source.revision.id} />
              <Definition label="Revision state" value={source.revision.state} />
              <Definition
                label="Revision digest"
                value={<DigestDisclosure digest={source.revision.digest} label="revision digest" />}
              />
              <Definition label="Created at" value={source.revision.createdAt} />
              <Definition label="Created by action" value={source.revision.createdByAction} />
            </dl>
          </div>
          <div>
            <h4>Source artifact</h4>
            <dl>
              <Definition label="Artifact version" value={source.artifact.id} />
              <Definition
                label="Artifact digest"
                value={<DigestDisclosure digest={source.artifact.digest} label="artifact digest" />}
              />
              <Definition label="Media type" value={source.artifact.mediaType} />
              <Definition label="Classification" value={source.artifact.classification} />
            </dl>
          </div>
        </div>
      ) : (
        <p className="kf-status kf-status-warning" role="status">
          {source.status === 'ambiguous'
            ? 'Source provenance is ambiguous under this caller context. No Holder or source revision is presented.'
            : 'No authored-source provenance record is visible under this caller context.'}
        </p>
      )}

      <div className="kf-table-scroll" tabIndex={0} aria-label="Parsed Block provenance table">
        <table
          aria-label="Parsed Block provenance"
          style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}
        >
          <thead>
            <tr>
              <th align="left">Parsed Block</th>
              <th align="left">Kind</th>
              <th align="left">Digest</th>
            </tr>
          </thead>
          <tbody>
            {document.parsedBlocks.map((block) => (
              <tr key={block.ordinal} style={{ borderTop: '1px solid #e2e8f0' }}>
                <td>{block.ordinal}</td>
                <td>{formatState(block.kind)}</td>
                <td style={{ fontFamily: 'monospace' }}>
                  <DigestDisclosure
                    digest={block.digest}
                    label={`Parsed Block ${block.ordinal} digest`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
