'use client';

import { useRef, type KeyboardEvent } from 'react';
import { WORKBENCH_TABS, type WorkbenchTab } from './workbench-types';

export function WorkbenchTabs({
  activeTab,
  onSelect,
}: {
  readonly activeTab: WorkbenchTab;
  readonly onSelect: (tab: WorkbenchTab) => void;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % WORKBENCH_TABS.length;
    if (event.key === 'ArrowLeft') {
      nextIndex = (index - 1 + WORKBENCH_TABS.length) % WORKBENCH_TABS.length;
    }
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = WORKBENCH_TABS.length - 1;
    if (nextIndex === undefined) return;
    event.preventDefault();
    onSelect(WORKBENCH_TABS[nextIndex]!);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Workbench views"
      aria-orientation="horizontal"
      style={{
        display: 'flex',
        gap: '0.35rem',
        flexWrap: 'wrap',
        borderBottom: '1px solid #cbd5e1',
      }}
    >
      {WORKBENCH_TABS.map((name, index) => (
        <button
          key={name}
          id={`workbench-tab-${index}`}
          ref={(element) => {
            tabRefs.current[index] = element;
          }}
          type="button"
          role="tab"
          aria-selected={activeTab === name}
          aria-controls="workbench-panel"
          tabIndex={activeTab === name ? 0 : -1}
          onClick={() => onSelect(name)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          style={{
            border: 0,
            borderBottom: activeTab === name ? '3px solid #0f766e' : '3px solid transparent',
            background: activeTab === name ? '#f0fdfa' : 'transparent',
            padding: '0.65rem 0.75rem',
            cursor: 'pointer',
            fontWeight: activeTab === name ? 700 : 400,
          }}
        >
          {name}
        </button>
      ))}
    </div>
  );
}
