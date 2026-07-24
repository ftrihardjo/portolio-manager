import { useEffect, useRef, useState } from 'react';
import BpmnModeler from 'bpmn-js/lib/Modeler';
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import { BpmnPropertiesPanelModule } from 'bpmn-js-properties-panel';
import TokenSimulationModule from 'bpmn-js-token-simulation';
import 'bpmn-js-token-simulation/assets/css/bpmn-js-token-simulation.css';
import 'bpmn-font/dist/css/bpmn.css';
import 'bpmn-js/dist/assets/diagram-js.css';
import JiraPropertiesProvider, { ReadOnlyLinkedResourcesGroup, getLinkedResources } from './JiraPropertiesProvider';
import jiraResourcesModdle from './moddle/jira-resources.json';

const EMPTY_BPMN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="false"><bpmn:startEvent id="StartEvent_1" /></bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1"><bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
    <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1"><dc:Bounds x="152" y="102" width="36" height="36" /></bpmndi:BPMNShape>
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn:definitions>`;

const MODDLE_EXTENSIONS = { jira: jiraResourcesModdle };
const READER_EXTENSIONS = { jira: jiraResourcesModdle };

function readIssueKey(element) {
  const bo = element && element.businessObject;
  if (!bo || typeof bo.get !== 'function') return '';
  const ext = bo.get('extensionElements');
  const values = ext && typeof ext.get === 'function' ? (ext.get('values') || []) : [];
  const linked = values.find((v) => v.$type === 'jira:LinkedResources');
  return (linked && linked.issueKey) || '';
}

// "3 minutes ago" style — viadee surfaces recency in its model header.
function formatRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const m = Math.round(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(iso).toLocaleDateString();
}

function ViewerPropertiesPanel({ instance }) {
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    if (!instance) return undefined;
    const eventBus = instance.get('eventBus');
    const onSel = (e) => setSelected(e.newSelection?.[0] || null);
    eventBus.on('selection.changed', onSel);
    return () => eventBus.off('selection.changed', onSel);
  }, [instance]);
  return (
    <aside data-testid="bpmn-properties-panel" className="bpmn-panel">
      {!selected
        ? <div className="bpmn-panel-empty">Select an element to see its linked Jira issues and documentation.</div>
        : <ReadOnlyLinkedResourcesGroup element={selected} />}
    </aside>
  );
}

// Sidebar navigator that lists every BPMN element carrying a
// jira:LinkedResources extension. The whole point is to be visible
// regardless of which element is currently selected in the bpmn-js
// canvas — that way enabling token simulation (which makes the panel
// focus the Process) doesn't hide the End Event's PAY-4 entry. Each row
// is a button: clicking it selects the element and pans the canvas so
// the user lands on it. The filter input narrows by name, issue key, or
// element type. The list is sorted by element id for a stable order.
function LinkedResourcesNavigator({ instance, onNavigate }) {
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!instance) return undefined;

    const collect = () => {
      const registry = instance.get('elementRegistry');
      const found = [];
      registry.getAll().forEach((el) => {
        if (!el || !el.businessObject) return;
        if (el.type === 'label' || el.type === 'root') return;
        const ext = getLinkedResources(el.businessObject);
        if (!ext) return;
        found.push({
          id: el.id,
          name: el.businessObject.name || el.id,
          type: el.type,
          issueKey: ext.issueKey || '',
          confluencePage: ext.confluencePage || '',
          documentation: ext.documentation || '',
        });
      });
      found.sort((a, b) => a.id.localeCompare(b.id));
      setItems(found);
    };

    collect();
    // Re-collect after any XML import or any modeling operation —
    // commandStack.changed fires on every add/remove/edit, which is
    // exactly when the set of elements-with-linked-resources can change.
    instance.on('import.done', collect);
    instance.on('commandStack.changed', collect);
    return () => {
      instance.off('import.done', collect);
      instance.off('commandStack.changed', collect);
    };
  }, [instance]);

  const q = query.trim().toLowerCase();
  const filtered = !q
    ? items
    : items.filter((it) =>
        (it.name || '').toLowerCase().includes(q) ||
        (it.issueKey || '').toLowerCase().includes(q) ||
        it.type.toLowerCase().includes(q)
      );

  return (
    <div className="bpmn-navigator" data-testid="bpmn-linked-resources-navigator">
      <div className="bpmn-nav-header">
        <h3 className="bpmn-nav-title">Linked Resources</h3>
        <span className="bpmn-nav-count" data-testid="bpmn-nav-count">{items.length}</span>
      </div>
      <input
        type="text"
        className="bpmn-nav-search"
        placeholder="Filter by name or key…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="bpmn-nav-search"
        aria-label="Filter linked resources by name, type, or issue key"
      />
      <ul className="bpmn-nav-list" data-testid="bpmn-nav-list">
        {filtered.length === 0 && (
          <li className="bpmn-nav-empty">
            {items.length === 0
              ? 'No elements have linked Jira resources yet. Select an element and add one in the Properties panel.'
              : 'No matches for that filter.'}
          </li>
        )}
        {filtered.map((item) => (
          <li key={item.id} className="bpmn-nav-item">
            <button
              type="button"
              className="bpmn-nav-item-btn"
              onClick={() => onNavigate(item.id)}
              data-testid={`bpmn-nav-item-${item.id}`}
              title={`Jump to ${item.name} (${item.type})`}
            >
              <div className="bpmn-nav-item-row">
                <span className="bpmn-nav-item-name">{item.name || item.id}</span>
                <span className="bpmn-nav-item-type">{item.type}</span>
              </div>
              {item.issueKey && (
                <div className="bpmn-nav-item-key">
                  <span className="bpmn-nav-item-key-pill">{item.issueKey}</span>
                </div>
              )}
              {item.confluencePage && (
                <div className="bpmn-nav-item-meta" title="Has Confluence page">📄 Confluence linked</div>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function BpmnDiagramView({
  diagramXml, canEdit, onSave, onDirtyChange, saveDisabled,
  // viadee-style model header (all optional / backwards compatible)
  modelName, modelVersion, modelLastEditedBy, modelLastEditedAt, currentAccountId,
}) {
  const canvasRef = useRef(null);
  const instanceRef = useRef(null);
  const [instance, setInstance] = useState(null);
  const [tokenSimEnabled, setTokenSimEnabled] = useState(false);

  // Toolbar state, synced from the live bpmn-js instance.
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [zoomPct, setZoomPct] = useState(100);

  // Issue-key find (top-right search bar).
  const [issueKeyQuery, setIssueKeyQuery] = useState('');
  const [findStatus, setFindStatus] = useState('');
  const findMatchesRef = useRef(null);
  const findCursorRef = useRef(-1);
  const lastQueryRef = useRef('');

  // Linked Resources Navigator — visible by default because token-simulation
  // can shift the bpmn-js Properties panel focus to the Process and hide
  // the End Event's linked resources; the navigator gives the user an
  // always-visible index of every element with a jira:LinkedResources
  // extension, plus a one-click jump to that element.
  const [showNavigator, setShowNavigator] = useState(true);

  useEffect(() => {
    if (!canvasRef.current) return undefined;
    const Ctor = canEdit ? BpmnModeler : BpmnViewer;
    const additionalModules = [];
    if (canEdit) additionalModules.push(BpmnPropertiesPanelModule);
    if (canEdit && tokenSimEnabled) additionalModules.push(TokenSimulationModule);

    const inst = new Ctor({
      container: canvasRef.current,
      ...(additionalModules.length > 0 ? { additionalModules } : {}),
      moddleExtensions: canEdit ? MODDLE_EXTENSIONS : READER_EXTENSIONS,
      ...(canEdit ? { propertiesPanel: { parent: '#js-properties-panel' } } : {}),
    });
    instanceRef.current = inst;
    setInstance(inst);

    if (canEdit) {
      try {
        // eslint-disable-next-line no-new
        new JiraPropertiesProvider(inst.get('propertiesPanel'));
      } catch (e) {
        console.error('Properties panel not available; install bpmn-js-properties-panel', e);
      }
    }

    // Keep toolbar buttons in sync with the instance.
    const commandStack = canEdit ? inst.get('commandStack') : null;
    const canvas = inst.get('canvas');
    const syncUndo = () => {
      if (!commandStack) return;
      setCanUndo(!!commandStack.canUndo());
      setCanRedo(!!commandStack.canRedo());
    };
    const syncZoom = () => {
      try { setZoomPct(Math.round((canvas.viewbox().scale || 1) * 100)); } catch (e) { /* ignore */ }
    };
    if (canEdit) {
      inst.on('commandStack.changed', () => { onDirtyChange?.(true); syncUndo(); });
    }
    inst.on('canvas.viewbox.changed', syncZoom);
    inst.on('import.done', syncZoom);

    inst.importXML(diagramXml || EMPTY_BPMN_XML)
      .then(() => { syncZoom(); syncUndo(); })
      .catch((err) => console.error('Failed to load BPMN diagram', err));

    return () => {
      inst.destroy();
      instanceRef.current = null;
      setInstance(null);
    };
  }, [diagramXml, canEdit, tokenSimEnabled]);

  const handleSave = async () => {
    if (!instanceRef.current || saveDisabled) return;
    const { xml } = await instanceRef.current.saveXML({ format: true });
    await onSave(xml);
    onDirtyChange?.(false);
  };

  // --- toolbar actions (real bpmn-js APIs) ---
  const undo = () => { try { instanceRef.current?.get('commandStack').undo(); } catch (e) { /* ignore */ } };
  const redo = () => { try { instanceRef.current?.get('commandStack').redo(); } catch (e) { /* ignore */ } };
  const zoomBy = (factor) => {
    const c = instanceRef.current?.get('canvas');
    if (!c) return;
    try {
      const vb = c.viewbox();
      const next = Math.min(4, Math.max(0.2, vb.scale * factor));
      c.zoom(next, { x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 });
    } catch (e) { /* ignore */ }
  };
  const zoomFit = () => { try { instanceRef.current?.get('canvas').zoom('fit-viewport'); } catch (e) { /* ignore */ } };

  // --- find by issue key ---
  const runFind = () => {
    const inst = instanceRef.current;
    if (!inst) return;
    const q = issueKeyQuery.trim().toUpperCase();
    if (!q) {
      setFindStatus(''); findMatchesRef.current = null; findCursorRef.current = -1; lastQueryRef.current = '';
      return;
    }
    if (q !== lastQueryRef.current) {
      lastQueryRef.current = q; findCursorRef.current = -1; findMatchesRef.current = null;
    }
    let matches = findMatchesRef.current;
    if (!matches) {
      matches = inst.get('elementRegistry').getAll().filter((el) => readIssueKey(el).toUpperCase().includes(q));
      findMatchesRef.current = matches;
    }
    if (matches.length === 0) { setFindStatus('No matches'); return; }
    findCursorRef.current = (findCursorRef.current + 1) % matches.length;
    const el = matches[findCursorRef.current];
    navigateToElement(el);
    setFindStatus(`${findCursorRef.current + 1} of ${matches.length}`);
  };

  // Selects an element in the canvas and pans the viewbox to centre on it.
  // Used by both the "Find" toolbar action and the Linked Resources
  // Navigator sidebar — extracting it keeps the math in one place so the
  // navigator jump and the search jump behave identically.
  const navigateToElement = (el) => {
    const inst = instanceRef.current;
    if (!inst || !el) return;
    try { inst.get('selection').select(el); } catch (e) { /* ignore */ }
    try {
      const pad = 80;
      const x = el.x ?? 0, y = el.y ?? 0, w = el.width || 120, hgt = el.height || 80;
      inst.get('canvas').viewbox({ x: x - pad, y: y - pad, width: w + pad * 2, height: hgt + pad * 2 });
    } catch (e) { /* ignore */ }
  };
  const onFindInputChange = (e) => {
    const v = e.target.value;
    setIssueKeyQuery(v);
    if (!v.trim()) { setFindStatus(''); findMatchesRef.current = null; findCursorRef.current = -1; lastQueryRef.current = ''; }
  };

  const editedByYou = modelLastEditedBy && currentAccountId && modelLastEditedBy === currentAccountId;

  return (
    <div className="bpmn-editor-shell">
      {/* Model header — name + version + last edited (viadee-style) */}
      <div className="bpmn-modelbar">
        <span className="bpmn-modelbar-title">{modelName || 'Untitled diagram'}</span>
        {typeof modelVersion === 'number' && <span className="bpmn-chip">v{modelVersion}</span>}
        <span className="bpmn-modelbar-meta">
          {modelLastEditedAt && (
            <>Last edited {formatRelative(modelLastEditedAt)}{editedByYou ? ' by you' : ''}</>
          )}
          {!canEdit && <span className="bpmn-chip" style={{ background: 'var(--ads-neutral)', color: 'var(--ads-text-sub)' }}>View only</span>}
        </span>
      </div>

      {/* Grouped toolbar */}
      <div className="bpmn-toolbar">
        {canEdit && (
          <>
            <div className="bpmn-tb-group">
              <button className="bpmn-tb-btn primary" onClick={handleSave} disabled={saveDisabled} data-testid="save-bpmn" title="Save diagram">Save</button>
            </div>
            <div className="bpmn-tb-group">
              <button className="bpmn-tb-btn" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">↶ Undo</button>
              <button className="bpmn-tb-btn" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Y)">↷ Redo</button>
            </div>
            <div className="bpmn-tb-group">
              <label className="bpmn-toggle" title="Animate tokens through the process">
                <input type="checkbox" data-testid="toggle-token-simulation"
                  checked={tokenSimEnabled} onChange={(e) => setTokenSimEnabled(e.target.checked)} />
                Token simulation
              </label>
            </div>
          </>
        )}

        <div className="bpmn-tb-group">
          <button
            className={`bpmn-tb-btn ${showNavigator ? 'primary' : ''}`}
            onClick={() => setShowNavigator((v) => !v)}
            data-testid="toggle-navigator"
            title={showNavigator ? 'Hide the Linked Resources navigator' : 'Show the Linked Resources navigator'}
            aria-pressed={showNavigator}
          >
            {showNavigator ? '◧' : '◨'} Navigator
          </button>
        </div>

        <div className="bpmn-tb-group">
          <button className="bpmn-tb-btn" onClick={() => zoomBy(1 / 1.2)} title="Zoom out">−</button>
          <button className="bpmn-tb-btn" onClick={zoomFit} title="Fit to screen" style={{ minWidth: 52 }}>{zoomPct}%</button>
          <button className="bpmn-tb-btn" onClick={() => zoomBy(1.2)} title="Zoom in">+</button>
        </div>

        <div className="bpmn-tb-spacer" />

        <div className="bpmn-find">
          <input type="text" data-testid="bpmn-find-issue-key"
            placeholder="Find by issue key (e.g. PROJ-123)"
            value={issueKeyQuery} onChange={onFindInputChange}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runFind(); } }} />
          <button className="bpmn-tb-btn" onClick={runFind} data-testid="bpmn-find-button">Find</button>
          {findStatus && <span className="bpmn-find-status">{findStatus}</span>}
        </div>
      </div>

      {/* Canvas + properties / attribute panel. Order is intentional:
          navigator on the left, canvas in the middle, properties on the
          right — matches the viadee "BPMN Modeler for Confluence"
          layout shown in the design reference. The navigator stays open
          even when token simulation shifts the bpmn-js Properties panel
          focus to the Process, so the End Event's linked resources
          remain one click away. */}
      <div className="bpmn-canvas-col">
        {showNavigator && (
          <LinkedResourcesNavigator
            instance={instance}
            onNavigate={(elementId) => {
              const el = instanceRef.current?.get('elementRegistry').get(elementId);
              if (el) navigateToElement(el);
            }}
          />
        )}
        <div ref={canvasRef} data-testid="bpmn-canvas" className="bpmn-canvas" />
        {canEdit
          ? <div id="js-properties-panel" data-testid="bpmn-properties-panel" className="bpmn-panel" />
          : <ViewerPropertiesPanel instance={instance} />}
      </div>
    </div>
  );
}