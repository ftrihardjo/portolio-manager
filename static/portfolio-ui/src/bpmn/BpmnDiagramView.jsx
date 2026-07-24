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

const EXTENSIONS = { jira: jiraResourcesModdle };

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
    <aside data-testid="bpmn-properties-panel" style={{
      width: 280, flexShrink: 0, border: '1px solid #ddd', borderRadius: 4,
      background: '#fff', maxHeight: 500, overflowY: 'auto',
    }}>
      {!selected
        ? <div style={{ padding: 12, color: '#666', fontSize: 12 }}>Select an element to see its linked Jira issues and documentation.</div>
        : <ReadOnlyLinkedResourcesGroup element={selected} />}
    </aside>
  );
}

export default function BpmnDiagramView({ diagramXml, canEdit, onSave, onDirtyChange, saveDisabled }) {
  const canvasRef = useRef(null);
  const instanceRef = useRef(null);
  const [instance, setInstance] = useState(null);
  const [tokenSimEnabled, setTokenSimEnabled] = useState(false);
  const [tokenSimRunning, setTokenSimRunning] = useState(false);

  // The live, in-memory XML. Toggling token simulation remounts the editor
  // (the module can only be added at construction); without this ref the
  // remount would re-import the stale `diagramXml` prop and silently discard
  // every unsaved edit (the "label + properties vanished" bug).
  const liveXmlRef = useRef(null);

  // A *prop* change means a real diagram switch or a remote reload: start
  // clean so the next import uses the new prop, not a stale live snapshot.
  // This effect deliberately does NOT run on a token-sim remount (the prop
  // is unchanged then), which is exactly what preserves the edits.
  useEffect(() => { liveXmlRef.current = null; }, [diagramXml]);

  useEffect(() => {
    if (!canvasRef.current) return undefined;
    const Ctor = canEdit ? BpmnModeler : BpmnViewer;
    const additionalModules = [];
    if (canEdit) additionalModules.push(BpmnPropertiesPanelModule);
    if (canEdit && tokenSimEnabled) additionalModules.push(TokenSimulationModule);

    const inst = new Ctor({
      container: canvasRef.current,
      ...(additionalModules.length ? { additionalModules } : {}),
      moddleExtensions: EXTENSIONS,
      ...(canEdit ? { propertiesPanel: { parent: '#js-properties-panel' } } : {}),
    });
    instanceRef.current = inst;
    setInstance(inst);

    if (canEdit) {
      try {
        // eslint-disable-next-line no-new
        new JiraPropertiesProvider(inst.get('propertiesPanel'));
      } catch (e) {
        console.error('Properties panel not available', e);
      }
    }

    // Import the preserved in-memory XML if we have it (token-sim remount),
    // otherwise the prop (first mount / diagram switch / remote reload).
    inst.importXML(liveXmlRef.current || diagramXml || EMPTY_BPMN_XML)
      .catch((err) => console.error('Failed to load BPMN diagram', err));

    let syncTimer = null;
    if (canEdit) {
      inst.on('commandStack.changed', () => {
        onDirtyChange?.(true);
        // Keep liveXmlRef fresh so a later remount can restore the work.
        clearTimeout(syncTimer);
        syncTimer = setTimeout(() => {
          if (inst !== instanceRef.current) return; // destroyed in the meantime
          inst.saveXML({ format: true })
            .then(({ xml }) => { if (inst === instanceRef.current) liveXmlRef.current = xml; })
            .catch(() => {});
        }, 400);
      });
    }

    return () => {
      clearTimeout(syncTimer);
      inst.destroy();
      instanceRef.current = null;
      setInstance(null);
    };
  }, [diagramXml, canEdit, tokenSimEnabled]);

  const handleSave = async () => {
    if (!instanceRef.current || saveDisabled) return;
    const { xml } = await instanceRef.current.saveXML({ format: true });
    liveXmlRef.current = xml;
    await onSave(xml);
    onDirtyChange?.(false);
  };

  useEffect(() => {
    if (!canEdit || !tokenSimEnabled || !instanceRef.current) return undefined;
    const eventBus = instanceRef.current.get('eventBus');
    const onRun = () => setTokenSimRunning(true);
    const onPause = () => setTokenSimRunning(false);
    eventBus.on('tokenSimulation.toggle', onRun);
    eventBus.on('tokenSimulation.pause', onPause);
    eventBus.on('tokenSimulation.play', onRun);
    return () => {
      eventBus.off('tokenSimulation.toggle', onRun);
      eventBus.off('tokenSimulation.pause', onPause);
      eventBus.off('tokenSimulation.play', onRun);
    };
  }, [canEdit, tokenSimEnabled]);

  const handlePlayPause = () => {
    if (!instanceRef.current) return;
    const ts = instanceRef.current.get('tokenSimulation');
    if (tokenSimRunning) ts.pause(); else ts.play();
  };
  const handleResetSim = () => instanceRef.current?.get('tokenSimulation').reset();

  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {canEdit && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <button onClick={handleSave} disabled={saveDisabled} data-testid="save-bpmn">Save Diagram</button>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
              <input type="checkbox" data-testid="toggle-token-simulation"
                checked={tokenSimEnabled} onChange={(e) => setTokenSimEnabled(e.target.checked)} />
              Enable token simulation
            </label>
            {tokenSimEnabled && (
              <>
                <button onClick={handlePlayPause} data-testid="token-sim-play-pause" style={{ fontSize: 12, padding: '4px 10px' }}>
                  {tokenSimRunning ? 'Pause' : 'Play'}
                </button>
                <button onClick={handleResetSim} data-testid="token-sim-reset" style={{ fontSize: 12, padding: '4px 10px' }}>Reset</button>
                <span style={{ fontSize: 11, color: '#666' }}>Tip: click a start event to spawn a token. Trails show each token's path.</span>
              </>
            )}
          </div>
        )}
        <div ref={canvasRef} data-testid="bpmn-canvas"
          style={{ height: 500, border: '1px solid #ddd', borderRadius: 4, background: '#fff' }} />
      </div>
      {canEdit
        ? <div id="js-properties-panel" data-testid="bpmn-properties-panel" style={{
            width: 280, flexShrink: 0, border: '1px solid #ddd', borderRadius: 4,
            background: '#fff', maxHeight: 500, overflowY: 'auto',
          }} />
        : <ViewerPropertiesPanel instance={instance} />}
    </div>
  );
}