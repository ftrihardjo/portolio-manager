import { useEffect, useRef, useState } from 'react';
import BpmnModeler from 'bpmn-js/lib/Modeler';
import BpmnViewer from 'bpmn-js/lib/NavigatedViewer';
import { BpmnPropertiesPanelModule } from 'bpmn-js-properties-panel';
import TokenSimulationModule from 'bpmn-js-token-simulation';
import 'bpmn-js-token-simulation/assets/css/bpmn-js-token-simulation.css';
import 'bpmn-font/dist/css/bpmn.css';
import 'bpmn-js/dist/assets/diagram-js.css';
import { getBusinessObject } from 'bpmn-js/lib/util/ModelUtil';
import JiraPropertiesProvider, {
  setModelerServices,
  getLinkedResources,
  ISSUE_KEY_PATTERN,
} from './JiraPropertiesProvider';
import jiraResourcesModdle from './moddle/jira-resources.json';

// Canary: confirm in DevTools console that the freshly built bundle is live.
console.log('[BpmnDiagramView] build 2026-07-23 v5');

// Larger editing surface, as requested.
const CANVAS_HEIGHT = 'clamp(560px, 70vh, 900px)';
const PANEL_WIDTH = 340;

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

// --- React read-only panel: plain data + plain JSX (no Preact vnodes here,
//     which is what used to blank the screen on selection). ----------------
function Field({ label, value, link, multiline }) {
  if (!value) return null;
  return (
    <div style={{ marginBottom: '6px' }}>
      <div style={{ fontSize: '11px', color: '#5e6c84', marginBottom: '2px' }}>{label}</div>
      {link ? (
        <a href={value} target="_blank" rel="noopener noreferrer" style={{ fontSize: '12px', color: '#0052cc' }}>{value}</a>
      ) : (
        <div style={{ fontSize: '12px', whiteSpace: multiline ? 'pre-wrap' : 'normal' }}>{value}</div>
      )}
    </div>
  );
}

function ViewerPropertiesPanel({ instance }) {
  const [selected, setSelected] = useState(null);
  useEffect(() => {
    if (!instance) return undefined;
    const eventBus = instance.get('eventBus');
    const onSelectionChanged = (e) => setSelected(e.newSelection?.[0] || null);
    eventBus.on('selection.changed', onSelectionChanged);
    return () => eventBus.off('selection.changed', onSelectionChanged);
  }, [instance]);

  const data = selected ? getLinkedResources(getBusinessObject(selected)) : null;

  return (
    <aside
      data-testid="bpmn-properties-panel"
      style={{
        width: PANEL_WIDTH, flexShrink: 0, border: '1px solid #ddd',
        borderRadius: '4px', background: '#fff', maxHeight: CANVAS_HEIGHT, overflowY: 'auto',
      }}
    >
      {!data ? (
        <div style={{ padding: '12px', color: '#666', fontSize: '12px' }}>
          Select an element to see its linked Jira issues and documentation.
        </div>
      ) : (
        <div style={{ padding: '10px 12px' }}>
          <h3 style={{ fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase', margin: '0 0 8px', color: '#42526e' }}>
            Linked Resources
          </h3>
          <Field label="Issue Key" value={data.issueKey} />
          <Field label="Confluence URL" value={data.confluencePage} link />
          <Field label="Documentation" value={data.documentation} multiline />
          <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
            <button
              type="button"
              onClick={() => { if (ISSUE_KEY_PATTERN.test(data.issueKey)) window.__openIssueInJira?.(data.issueKey); }}
              disabled={!ISSUE_KEY_PATTERN.test(data.issueKey)}
              style={{ fontSize: '11px', padding: '4px 8px' }}
            >Open in Jira</button>
            <button
              type="button"
              onClick={() => { if (data.confluencePage) window.__routerOpen?.(data.confluencePage); }}
              disabled={!data.confluencePage}
              style={{ fontSize: '11px', padding: '4px 8px' }}
            >Open in Confluence</button>
          </div>
        </div>
      )}
    </aside>
  );
}

export default function BpmnDiagramView({ diagramXml, canEdit, onSave, onDirtyChange }) {
  const canvasRef = useRef(null);
  const instanceRef = useRef(null);
  const [instance, setInstance] = useState(null);
  const [tokenSimEnabled, setTokenSimEnabled] = useState(false);
  const [tokenSimRunning, setTokenSimRunning] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return undefined;
    const Ctor = canEdit ? BpmnModeler : BpmnViewer;
    const additionalModules = [];
    if (canEdit) additionalModules.push(BpmnPropertiesPanelModule);
    if (canEdit && tokenSimEnabled) additionalModules.push(TokenSimulationModule);

    const inst = new Ctor({
      container: canvasRef.current,
      ...(additionalModules.length > 0 ? { additionalModules } : {}),
      moddleExtensions: MODDLE_EXTENSIONS,
      ...(canEdit ? { propertiesPanel: { parent: '#js-properties-panel' } } : {}),
    });
    instanceRef.current = inst;
    setInstance(inst);

    if (canEdit) {
      // Wire modeling/moddle into the provider BEFORE registering it.
      setModelerServices(inst.get('modeling'), inst.get('moddle'));
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
    if (!instanceRef.current) return;
    const { xml } = await instanceRef.current.saveXML({ format: true });
    await onSave(xml);
    onDirtyChange?.(false);
  };

  useEffect(() => {
    if (!canEdit || !tokenSimEnabled || !instanceRef.current) return undefined;
    const eventBus = instanceRef.current.get('eventBus');
    const onRunning = () => setTokenSimRunning(true);
    const onPaused = () => setTokenSimRunning(false);
    eventBus.on('tokenSimulation.toggle', onRunning);
    eventBus.on('tokenSimulation.pause', onPaused);
    eventBus.on('tokenSimulation.play', onRunning);
    return () => {
      eventBus.off('tokenSimulation.toggle', onRunning);
      eventBus.off('tokenSimulation.pause', onPaused);
      eventBus.off('tokenSimulation.play', onRunning);
    };
  }, [canEdit, tokenSimEnabled]);

  const handlePlayPause = () => {
    if (!instanceRef.current) return;
    const ts = instanceRef.current.get('tokenSimulation');
    if (tokenSimRunning) ts.pause(); else ts.play();
  };
  const handleResetSim = () => instanceRef.current?.get('tokenSimulation')?.reset();

  return (
    <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 520px', minWidth: 0 }}>
        {canEdit && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' }}>
            <button onClick={handleSave} data-testid="save-bpmn">Save Diagram</button>
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                data-testid="toggle-token-simulation"
                checked={tokenSimEnabled}
                onChange={(e) => setTokenSimEnabled(e.target.checked)}
              />
              Enable token simulation
            </label>
            {tokenSimEnabled && (
              <>
                <button onClick={handlePlayPause} data-testid="token-sim-play-pause" style={{ fontSize: '12px', padding: '4px 10px' }}>
                  {tokenSimRunning ? 'Pause' : 'Play'}
                </button>
                <button onClick={handleResetSim} data-testid="token-sim-reset" style={{ fontSize: '12px', padding: '4px 10px' }}>Reset</button>
                <span style={{ fontSize: '11px', color: '#666' }}>Tip: click a start event to spawn a token.</span>
              </>
            )}
          </div>
        )}
        <div
          ref={canvasRef}
          data-testid="bpmn-canvas"
          style={{ height: CANVAS_HEIGHT, border: '1px solid #ddd', borderRadius: '4px', background: '#fff' }}
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