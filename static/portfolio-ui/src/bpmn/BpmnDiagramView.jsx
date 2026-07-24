import { useEffect, useRef, useState } from 'react';
import BpmnModeler from 'bpmn-js/lib/Modeler';
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import { BpmnPropertiesPanelModule } from 'bpmn-js-properties-panel';
import TokenSimulationModule from 'bpmn-js-token-simulation';
import 'bpmn-js-token-simulation/assets/css/bpmn-js-token-simulation.css';
import 'bpmn-font/dist/css/bpmn.css';
import 'bpmn-js/dist/assets/diagram-js.css';
import JiraPropertiesProvider, { ReadOnlyLinkedResourcesGroup } from './JiraPropertiesProvider';
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
    try { inst.get('selection').select(el); } catch (e) { /* ignore */ }
    try {
      const pad = 80;
      const x = el.x ?? 0, y = el.y ?? 0, w = el.width || 120, hgt = el.height || 80;
      inst.get('canvas').viewbox({ x: x - pad, y: y - pad, width: w + pad * 2, height: hgt + pad * 2 });
    } catch (e) { /* ignore */ }
    setFindStatus(`${findCursorRef.current + 1} of ${matches.length}`);
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

      {/* Canvas + properties / attribute panel */}
      <div className="bpmn-canvas-col">
        <div ref={canvasRef} data-testid="bpmn-canvas" className="bpmn-canvas" />
        {canEdit
          ? <div id="js-properties-panel" data-testid="bpmn-properties-panel" className="bpmn-panel" />
          : <ViewerPropertiesPanel instance={instance} />}
      </div>
    </div>
  );
}