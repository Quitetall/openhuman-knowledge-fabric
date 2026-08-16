'use client';

import { useEffect, useRef, useState } from 'react';
import type { DocumentDetail, DocumentWorkspace, MetricPanel } from '../../../lib/api';
import { PublicationPanel, ProposalPanel } from './workbench-authoring-panels';
import { CompositionPanel } from './workbench-composition-panel';
import { DiagnosticsPanel } from './workbench-diagnostics-panel';
import { OutlinePanel, ProvenancePanel, SourcePanel } from './workbench-inspection-panels';
import { MetricsPanel } from './workbench-metrics-panel';
import { NavigationPanel } from './workbench-navigation-panel';
import { PreviewPanel } from './workbench-preview';
import { ProjectionDownloads } from './workbench-projections';
import { WorkbenchTabs } from './workbench-tabs';
import { WORKBENCH_TABS, type WorkbenchTab } from './workbench-types';

export function DocumentWorkbench({
  document,
  workspace,
  workspaceError,
  metrics,
}: {
  readonly document: DocumentDetail;
  readonly workspace: DocumentWorkspace;
  readonly workspaceError: string | undefined;
  readonly metrics: MetricPanel;
}) {
  const [tab, setTab] = useState<WorkbenchTab>('Preview');
  const [proposal, setProposal] = useState('');
  const [semanticNote, setSemanticNote] = useState('');
  const pendingHeadingOrdinal = useRef<number | null>(null);
  const headings = document.parsedBlocks.filter((block) => block.kind === 'heading');
  const activeIndex = WORKBENCH_TABS.indexOf(tab);

  useEffect(() => {
    if (tab !== 'Preview' || pendingHeadingOrdinal.current === null) return;
    const target = globalThis.document.getElementById(
      `parsed-block-${pendingHeadingOrdinal.current}`,
    );
    pendingHeadingOrdinal.current = null;
    if (target === null) return;
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
  }, [tab]);

  function showHeadingInPreview(ordinal: number): void {
    pendingHeadingOrdinal.current = ordinal;
    setTab('Preview');
  }

  return (
    <section aria-label="Document workbench" style={{ marginTop: '2rem' }}>
      <WorkbenchTabs activeTab={tab} onSelect={setTab} />

      <div
        id="workbench-panel"
        role="tabpanel"
        aria-labelledby={`workbench-tab-${activeIndex}`}
        tabIndex={0}
        style={{ minHeight: '22rem', padding: '1.5rem 0' }}
      >
        {workspaceError === undefined ? null : (
          <p className="kf-status kf-status-warning" role="status">
            {workspaceError} Exact-Basis controls remain disabled.
          </p>
        )}
        {tab === 'Preview' ? (
          <>
            <ProjectionDownloads documentId={document.id} workspace={workspace} />
            <PreviewPanel parsedBlocks={document.parsedBlocks} />
          </>
        ) : null}
        {tab === 'Source' ? <SourcePanel document={document} /> : null}
        {tab === 'Outline' ? (
          <OutlinePanel headings={headings} onShowHeading={showHeadingInPreview} />
        ) : null}
        {tab === 'Composition' ? <CompositionPanel workspace={workspace} /> : null}
        {tab === 'Navigation' ? <NavigationPanel workspace={workspace} /> : null}
        {tab === 'Provenance' ? <ProvenancePanel document={document} workspace={workspace} /> : null}
        {tab === 'Diagnostics' ? (
          <DiagnosticsPanel document={document} workspace={workspace} />
        ) : null}
        {tab === 'Semantics & proposal' ? (
          <ProposalPanel
            proposal={proposal}
            semanticNote={semanticNote}
            documentId={document.id}
            workspace={workspace}
            onProposalChange={setProposal}
            onSemanticNoteChange={setSemanticNote}
          />
        ) : null}
        {tab === 'Publication' ? (
          <PublicationPanel document={document} workspace={workspace} />
        ) : null}
        {tab === 'Metrics' ? <MetricsPanel metrics={metrics} /> : null}
      </div>
    </section>
  );
}
