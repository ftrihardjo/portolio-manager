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

// Minimal valid BPMN 2.0 XML — bpmn-js needs *something* to import
// even for a brand-new, never-saved diagram. Same as before.
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

const MODDLE_EXTENSIONS = {
  jira: jiraResourcesModdle,
};

// The Viewer doesn't have a modeling service, so it can't run the
// editable provider. It still gets the moddle extension loaded so
// existing jira:LinkedResources in the XML deserializes correctly —
// without this, save → reopen would silently drop the Jira/Confluence
// fields because the extension types would be unknown.
const READER_EXTENSIONS = {
  jira: jiraResourcesModdle,
};

// Tiny read-only panel that the Viewer mounts by hand. bpmn-js's
// official properties panel is editor-only (it expects a modeling
// service and listens for commandStack events), so for viewers we
// re-implement the same surface as a static observer. Listens to
// selection.changed on the viewer's eventBus and re-renders the
// linked-resources group for whatever's selected.
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
        width: '280px',
        flexShrink: 0,
        border: '1px solid #ddd',
        borderRadius: '4px',
        background: '#fff',
        maxHeight: '500px',
        overflowY: 'auto',
      }}
    >
      {!selected && (
        <div style={{ padding: '12px', color: '#666', fontSize: '12px' }}>
          Select an element to see its linked Jira issues and documentation.
        </div>
      )}
      {selected && <ReadOnlyLinkedResourcesGroup element={selected} />}
    </aside>
  );
}

export default function BpmnDiagramView({ diagramXml, canEdit, onSave, onDirtyChange }) {
  const canvasRef = useRef(null);
  const instanceRef = useRef(null);
  // Tracks the bpmn-js instance as state (not just a ref) so the
  // Viewer's read-only panel re-renders when the instance becomes
  // available. A plain ref would be silently stale: the panel would
  // mount with `instance=null` and never see the actual instance
  // because mutating a ref doesn't trigger a re-render in React.
  const [instance, setInstance] = useState(null);
  const [tokenSimEnabled, setTokenSimEnabled] = useState(false);
  const [tokenSimRunning, setTokenSimRunning] = useState(false);

  useEffect(() => {
    if (!canvasRef.current) return undefined;

    const Ctor = canEdit ? BpmnModeler : BpmnViewer;
    const additionalModules = [];
    if (canEdit) {
      // BpmnPropertiesPanelModule registers the `propertiesPanel`
      // service and instantiates the default BpmnPropertiesProvider
      // (Id / Name / General / etc.) in one go — without it, the
      // `propertiesPanel` service below wouldn't exist, and the
      // JiraPropertiesProvider we register manually would crash
      // trying to read it.
      additionalModules.push(BpmnPropertiesPanelModule);
    }
    if (canEdit && tokenSimEnabled) {
      // Token simulation is opt-in via the toggle rather than always-on:
      // it adds a sidebar with its own controls, which clutters the
      // canvas for users who just want to view the workflow. The module
      // must be passed at construction time — it can't be toggled
      // later without re-instantiating the modeler (which is why the
      // useEffect below depends on tokenSimEnabled).
      additionalModules.push(TokenSimulationModule);
    }

    const instance = new Ctor({
      container: canvasRef.current,
      ...(additionalModules.length > 0 ? { additionalModules } : {}),
      moddleExtensions: canEdit ? MODDLE_EXTENSIONS : READER_EXTENSIONS,
      ...(canEdit ? {
        // The modeler auto-mounts the properties panel into this DOM
        // node when the service starts. Must be a CSS selector, not a
        // React ref, since bpmn-js reaches into the DOM itself.
        propertiesPanel: { parent: '#js-properties-panel' },
      } : {}),
    });
    instanceRef.current = instance;
    setInstance(instance);

    // Register the custom properties provider after construction.
    // BpmnPropertiesPanelModule wires up the default groups; we
    // register JiraPropertiesProvider manually so it can register at
    // priority 500 (after the default) rather than being added to
    // additionalModules, which would only let us run alongside or
    // before the default — and "before" would push the default Id/
    // Name group out of its expected top-of-panel position.
    if (canEdit) {
      try {
        const propertiesPanel = instance.get('propertiesPanel');
        // eslint-disable-next-line no-new
        new JiraPropertiesProvider(propertiesPanel);
      } catch (e) {
        console.error('Properties panel not available; install bpmn-js-properties-panel', e);
      }
    }

    instance.importXML(diagramXml || EMPTY_BPMN_XML).catch((err) => {
      console.error('Failed to load BPMN diagram', err);
    });

    if (canEdit) {
      instance.on('commandStack.changed', () => onDirtyChange?.(true));
    }

    return () => {
      instance.destroy();
      instanceRef.current = null;
      setInstance(null);
    };
    // (onDirtyChange and onSave are intentionally left out of the
    // dependency array below: they're stable per-render closures here,
    // and including them would force a pointless remount of the
    // bpmn-js instance on every render.)
  }, [diagramXml, canEdit, tokenSimEnabled]);

  const handleSave = async () => {
    if (!instanceRef.current) return;
    const { xml } = await instanceRef.current.saveXML({ format: true });
    await onSave(xml);
    onDirtyChange?.(false);
  };

  // Token simulation control — small wrapper around the bpmn-js-token-
  // simulation plugin's services. The plugin tracks running state on
  // its own, so we just observe its events to keep the button label
  // in sync.
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
    const tokenSimulation = instanceRef.current.get('tokenSimulation');
    if (tokenSimRunning) tokenSimulation.pause();
    else tokenSimulation.play();
  };

  const handleResetSim = () => {
    if (!instanceRef.current) return;
    instanceRef.current.get('tokenSimulation').reset();
  };

  return (
    <div style={{ display: 'flex', gap: '12px' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
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
                <button
                  onClick={handlePlayPause}
                  data-testid="token-sim-play-pause"
                  style={{ fontSize: '12px', padding: '4px 10px' }}
                >
                  {tokenSimRunning ? 'Pause' : 'Play'}
                </button>
                <button
                  onClick={handleResetSim}
                  data-testid="token-sim-reset"
                  style={{ fontSize: '12px', padding: '4px 10px' }}
                >
                  Reset
                </button>
                <span style={{ fontSize: '11px', color: '#666' }}>
                  Tip: click on a start event to spawn a token. Trails show each token's path.
                </span>
              </>
            )}
          </div>
        )}
        <div
          ref={canvasRef}
          data-testid="bpmn-canvas"
          style={{ height: '500px', border: '1px solid #ddd', borderRadius: '4px', background: '#fff' }}
        />
      </div>

      {/* The editable Modeler mounts the official @bpmn-io/properties-
          panel into this container (see the `parent: '#js-properties-panel'`
          option above). The Viewer instead renders a hand-rolled read-
          only panel, which doesn't need a DOM target. */}
      {canEdit ? (
        <div
          id="js-properties-panel"
          data-testid="bpmn-properties-panel"
          style={{
            width: '280px',
            flexShrink: 0,
            border: '1px solid #ddd',
            borderRadius: '4px',
            background: '#fff',
            maxHeight: '500px',
            overflowY: 'auto',
          }}
        />
      ) : (
        <ViewerPropertiesPanel instance={instance} />
      )}
    </div>
  );
}
