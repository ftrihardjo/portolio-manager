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
  <bpmn:process id="Process_1" isExecutable="false">
    <bpmn:startEvent id="StartEvent_1" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="152" y="102" width="36" height="36" />
      </bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

const MODDLE_EXTENSIONS = { jira: jiraResourcesModdle };
const READER_EXTENSIONS = { jira: jiraResourcesModdle };

const CANVAS_HEIGHT = '70vh';
const CANVAS_MIN_HEIGHT = '520px';
const PANEL_WIDTH = 320;

// Read the jira:issueKey off an element's extensionElements (self-contained,
// no coupling to the provider's internals).
function readIssueKey(element) {
  const bo = element && element.businessObject;
  if (!bo || typeof bo.get !== 'function') return '';
  const ext = bo.get('extensionElements');
  const values = ext && typeof ext.get === 'function' ? (ext.get('values') || []) : [];
  const linked = values.find((v) => v.$type === 'jira:LinkedResources');
  return (linked && linked.issueKey) || '';
}

// Read-only panel for the Viewer (pure React — no Preact vnodes in React tree).
function ViewerPropertiesPanel({ instance }) {
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    if (!instance) return undefined;
    const eventBus = instance.get('eventBus');
    const onSelectionChanged = (e) => setSelected(e.newSelection?.[0] || null);
    eventBus.on('selection.changed', onSelectionChanged);
    return () => eventBus.off('selection.changed', onSelectionChanged);
  }, [instance]);
  return (
    <aside
      data-testid="bpmn-properties-panel"
      style={{
        width: PANEL_WIDTH, flexShrink: 0, border: '1px solid #ddd',
        borderRadius: '4px', background: '#fff', maxHeight: CANVAS_HEIGHT, overflowY: 'auto',
      }}
    >
      {!selected ? (
        <div style={{ padding: '12px', color: '#666', fontSize: '12px' }}>
          Select an element to see its linked Jira issues and documentation.
        </div>
      ) : (
        <ReadOnlyLinkedResourcesGroup element={selected} />
      )}
    </aside>
  );
}

export default function BpmnDiagramView({ diagramXml, canEdit, onSave, onDirtyChange, saveDisabled }) {
  const canvasRef = useRef(null);
  const instanceRef = useRef(null);
  const [instance, setInstance] = useState(null);
  const [tokenSimEnabled, setTokenSimEnabled] = useState(false);

  // Issue-key search state (top-right search bar).
  const [issueKeyQuery, setIssueKeyQuery] = useState('');
  const [findStatus, setFindStatus] = useState('');
  const findMatchesRef = useRef(null);
  const findCursorRef = useRef(-1);
  const lastQueryRef = useRef('');

  // (Re)create the bpmn-js instance. Token-simulation module is added only
  // when the checkbox is on; it draws its OWN play/pause overlay on the
  // canvas, so we no longer need manual Play/Reset buttons.
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
    inst.importXML(diagramXml || EMPTY_BPMN_XML).catch((err) =>
      console.error('Failed to load BPMN diagram', err)
    );
    if (canEdit) inst.on('commandStack.changed', () => onDirtyChange?.(true));

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

  // Find elements whose jira:issueKey contains the query; cycle + zoom.
  const runFind = () => {
    const inst = instanceRef.current;
    if (!inst) return;
    const q = issueKeyQuery.trim().toUpperCase();
    if (!q) {
      setFindStatus('');
      findMatchesRef.current = null;
      findCursorRef.current = -1;
      lastQueryRef.current = '';
      return;
    }
    if (q !== lastQueryRef.current) {
      lastQueryRef.current = q;
      findCursorRef.current = -1;
      findMatchesRef.current = null;
    }
    let matches = findMatchesRef.current;
    if (!matches) {
      matches = inst.get('elementRegistry').getAll().filter((el) =>
        readIssueKey(el).toUpperCase().includes(q)
      );
      findMatchesRef.current = matches;
    }
    if (matches.length === 0) {
      setFindStatus('No matches');
      return;
    }
    findCursorRef.current = (findCursorRef.current + 1) % matches.length;
    const el = matches[findCursorRef.current];
    try { inst.get('selection').select(el); } catch (e) { /* ignore */ }
    try {
      const pad = 80;
      const x = el.x ?? 0;
      const y = el.y ?? 0;
      const w = el.width || 120;
      const hgt = el.height || 80;
      inst.get('canvas').viewbox({ x: x - pad, y: y - pad, width: w + pad * 2, height: hgt + pad * 2 });
    } catch (e) { /* ignore */ }
    setFindStatus(`${findCursorRef.current + 1} of ${matches.length}`);
  };

  const onFindInputChange = (e) => {
    const v = e.target.value;
    setIssueKeyQuery(v);
    if (!v.trim()) {
      setFindStatus('');
      findMatchesRef.current = null;
      findCursorRef.current = -1;
      lastQueryRef.current = '';
    }
  };

  return (
    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 520px', minWidth: 0 }}>
        {/* Toolbar: save + token-sim on the left, issue-key search on the right */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' }}>
          {canEdit && (
            <>
              <button onClick={handleSave} disabled={saveDisabled} data-testid="save-bpmn">
                Save Diagram
              </button>
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  data-testid="toggle-token-simulation"
                  checked={tokenSimEnabled}
                  onChange={(e) => setTokenSimEnabled(e.target.checked)}
                />
                Enable token simulation
              </label>
            </>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: '6px', alignItems: 'center' }}>
            <input
              type="text"
              data-testid="bpmn-find-issue-key"
              placeholder="Find by issue key (e.g. PROJ-123)"
              value={issueKeyQuery}
              onChange={onFindInputChange}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runFind(); } }}
              style={{ padding: '4px 8px', fontSize: '12px', minWidth: '220px' }}
            />
            <button onClick={runFind} data-testid="bpmn-find-button" style={{ fontSize: '12px', padding: '4px 10px' }}>
              Find
            </button>
            {findStatus && <span style={{ fontSize: '11px', color: '#666', whiteSpace: 'nowrap' }}>{findStatus}</span>}
          </div>
        </div>

        <div
          ref={canvasRef}
          data-testid="bpmn-canvas"
          style={{ height: CANVAS_HEIGHT, minHeight: CANVAS_MIN_HEIGHT, border: '1px solid #ddd', borderRadius: '4px', background: '#fff' }}
        />
      </div>

      {canEdit ? (
        <div
          id="js-properties-panel"
          data-testid="bpmn-properties-panel"
          style={{
            width: PANEL_WIDTH, flexShrink: 0, border: '1px solid #ddd',
            borderRadius: '4px', background: '#fff', maxHeight: CANVAS_HEIGHT, overflowY: 'auto',
          }}
        />
      ) : (
        <ViewerPropertiesPanel instance={instance} />
      )}
    </div>
  );
}