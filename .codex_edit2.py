from pathlib import Path
ui = Path('ui/tabs/workflows.js')
u = ui.read_text(encoding='utf-8')
old = '''          onAskBosun=${() => openWorkflowCopilotFromCanvas({
            intent: "explain",
            nodeId: editingNode,
            title: `Ask Bosun about node ${editingNodeDef?.label || editingNode}`.trim(),
            successToast: "Opened node copilot chat",
          })}'''
new = '''          onAskBosun=${() => openWorkflowCopilotFromCanvas({
            intent: "explain",
            nodeId: editingNode,
            title: `Ask Bosun about node ${editingNodeDef?.label || editingNode}`.trim(),
            successToast: "Opened node copilot chat",
          })}
          onNodeAction=${(intent, preset) => openWorkflowCopilotFromCanvas({
            intent,
            nodeId: editingNode,
            title: `${preset?.label || "Node Action"} ${editingNodeDef?.label || editingNode}`.trim(),
            successToast: String(preset?.successToast || "Opened node copilot chat").trim(),
          })}'''
u = u.replace(old, new)
ui.write_text(u, encoding='utf-8')
