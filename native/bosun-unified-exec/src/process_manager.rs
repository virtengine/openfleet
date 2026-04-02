use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct ProcessManagerSnapshot {
    pub cancellation_supported: bool,
    pub backpressure_supported: bool,
    pub buffering_mode: &'static str,
}

pub fn snapshot() -> ProcessManagerSnapshot {
    ProcessManagerSnapshot {
        cancellation_supported: true,
        backpressure_supported: true,
        buffering_mode: "head_tail",
    }
}
