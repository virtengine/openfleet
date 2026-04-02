use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct AsyncWatcherSnapshot {
    pub protocol_version: u32,
    pub queueing_strategy: &'static str,
    pub ready: bool,
}

pub fn snapshot() -> AsyncWatcherSnapshot {
    AsyncWatcherSnapshot {
        protocol_version: 1,
        queueing_strategy: "stdio-jsonl",
        ready: true,
    }
}
