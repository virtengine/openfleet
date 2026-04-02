use serde_json::{json, Value};

fn text(value: Option<&Value>) -> String {
    value
        .and_then(|entry| entry.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub fn export_trace(events: &[Value]) -> Value {
    json!({
      "traceEvents": events.iter().map(|event| {
        let event_type = text(event.get("eventType"));
        let name = if event_type.is_empty() {
          text(event.get("type"))
        } else {
          event_type
        };
        json!({
          "name": name,
          "cat": text(event.get("category")),
          "ts": event.get("ts").cloned().unwrap_or(Value::Null),
          "ph": "i",
          "s": "t",
          "args": {
            "taskId": event.get("taskId").cloned().unwrap_or(Value::Null),
            "sessionId": event.get("sessionId").cloned().unwrap_or(Value::Null),
            "runId": event.get("runId").cloned().unwrap_or(Value::Null),
            "status": event.get("status").cloned().unwrap_or(Value::Null),
          }
        })
      }).collect::<Vec<_>>(),
    })
}
