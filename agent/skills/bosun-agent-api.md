# Skill: Bosun Agent Status API

- POST `/status` when starting a new phase or when context changes.
- POST `/heartbeat` during active work so Bosun does not requeue the task.
- POST `/error` with concise failure context before aborting.
- POST `/complete` only after verification is done and the task is truly finished.
