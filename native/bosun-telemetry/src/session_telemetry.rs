use serde_json::{json, Value};

use crate::export;
use crate::metrics;

fn text(value: Option<&Value>) -> String {
    value
        .and_then(|entry| entry.as_str())
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn filter_events(events: &[Value], filter: &Value) -> Vec<Value> {
    let task_id = text(filter.get("taskId"));
    let session_id = text(filter.get("sessionId"));
    let run_id = text(filter.get("runId"));
    let event_type = text(filter.get("type"));
    let category = text(filter.get("category"));
    let source = text(filter.get("source"));

    events
        .iter()
        .filter(|event| {
            (task_id.is_empty() || text(event.get("taskId")) == task_id)
                && (session_id.is_empty() || text(event.get("sessionId")) == session_id)
                && (run_id.is_empty() || text(event.get("runId")) == run_id || text(event.get("rootRunId")) == run_id)
                && (event_type.is_empty() || text(event.get("eventType")) == event_type || text(event.get("type")) == event_type)
                && (category.is_empty() || text(event.get("category")) == category)
                && (source.is_empty() || text(event.get("source")) == source)
        })
        .cloned()
        .collect()
}

pub struct TelemetryService {
    events: Vec<Value>,
    max_in_memory_events: usize,
}

impl TelemetryService {
    pub fn new() -> Self {
        Self {
            events: Vec::new(),
            max_in_memory_events: 20_000,
        }
    }

    fn append_events(&mut self, incoming: &[Value], requested_max: Option<usize>) -> Value {
        if let Some(limit) = requested_max {
            self.max_in_memory_events = limit.max(100);
        }
        self.events.extend(incoming.iter().cloned());
        if self.events.len() > self.max_in_memory_events {
            let overflow = self.events.len() - self.max_in_memory_events;
            self.events.drain(0..overflow);
        }
        json!({
            "service": "bosun-telemetry",
            "version": env!("CARGO_PKG_VERSION"),
            "accepted": incoming.len(),
            "eventCount": self.events.len(),
        })
    }

    pub fn handle_request(&mut self, request: &Value) -> Result<Value, String> {
        let command = request
            .get("command")
            .and_then(|value| value.as_str())
            .unwrap_or_default();

        match command {
            "status" => Ok(json!({
                "service": "bosun-telemetry",
                "version": env!("CARGO_PKG_VERSION"),
                "protocolVersion": 1,
                "eventCount": self.events.len(),
                "maxInMemoryEvents": self.max_in_memory_events,
            })),
            "append_events" => {
                let events = request
                    .get("events")
                    .and_then(|value| value.as_array())
                    .cloned()
                    .unwrap_or_default();
                let requested_max = request
                    .get("maxInMemoryEvents")
                    .and_then(|value| value.as_u64())
                    .map(|value| value as usize);
                Ok(self.append_events(&events, requested_max))
            }
            "list_events" => Ok(json!({
                "service": "bosun-telemetry",
                "events": filter_events(&self.events, request.get("filter").unwrap_or(&Value::Null)),
            })),
            "get_summary" => Ok(json!({
                "service": "bosun-telemetry",
                "summary": metrics::summarize_events(&self.events),
            })),
            "get_live_snapshot" => Ok(json!({
                "service": "bosun-telemetry",
                "live": metrics::live_snapshot(&self.events),
            })),
            "get_provider_usage" => Ok(json!({
                "service": "bosun-telemetry",
                "providers": metrics::provider_usage(&self.events),
            })),
            "export_trace" => {
                let filtered = filter_events(&self.events, request.get("filter").unwrap_or(&Value::Null));
                Ok(json!({
                    "service": "bosun-telemetry",
                    "trace": export::export_trace(&filtered),
                }))
            }
            "reset" => {
                self.events.clear();
                Ok(json!({
                    "service": "bosun-telemetry",
                    "reset": true,
                }))
            }
            _ => Err(format!("unknown_command:{command}")),
        }
    }
}
