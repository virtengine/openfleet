#!/bin/bash
#
# Agent Work Log Rotation Script
#
# Rotates and compresses agent work logs to prevent unbounded growth.
# Intended to run weekly via cron or manually.
#
# Usage: bash scripts/openfleet/rotate-agent-logs.sh

set -e

# ── Configuration ───────────────────────────────────────────────────────────

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$REPO_ROOT/.cache/agent-work-logs"
ARCHIVE_DIR="$LOG_DIR/archive"

# Retention periods
STREAM_RETENTION_DAYS=30
ERROR_RETENTION_DAYS=90
SESSION_RETENTION_COUNT=100
ARCHIVE_RETENTION_DAYS=180

# ── Functions ───────────────────────────────────────────────────────────────

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

ensure_dir() {
  if [ ! -d "$1" ]; then
    mkdir -p "$1"
    log "Created directory: $1"
  fi
}

rotate_file() {
  local file="$1"
  local archive_name="$2"
  local retention_days="$3"

  if [ ! -f "$file" ]; then
    log "Skipping $file (not found)"
    return
  fi

  local size=$(stat -c%s "$file" 2>/dev/null || stat -f%z "$file" 2>/dev/null || echo 0)
  if [ "$size" -eq 0 ]; then
    log "Skipping $file (empty)"
    return
  fi

  # Compress and archive
  log "Archiving $file → $archive_name ($(numfmt --to=iec-i --suffix=B $size))"
  gzip -c "$file" > "$ARCHIVE_DIR/$archive_name"

  # Truncate original file
  > "$file"
  log "Truncated $file"

  # Clean old archives
  if [ -n "$retention_days" ]; then
    find "$ARCHIVE_DIR" -name "$(basename "$archive_name" .gz)*" -type f -mtime +$retention_days -delete
    log "Cleaned archives older than $retention_days days"
  fi
}

clean_sessions() {
  local session_dir="$LOG_DIR/agent-sessions"
  local retention_count=$1

  if [ ! -d "$session_dir" ]; then
    return
  fi

  local session_count=$(find "$session_dir" -name "*.jsonl" -type f | wc -l)
  if [ "$session_count" -le "$retention_count" ]; then
    log "Session logs: $session_count/$retention_count (within limit)"
    return
  fi

  # Delete oldest sessions beyond retention limit
  log "Cleaning old session logs (keeping $retention_count newest)"
  ls -t "$session_dir"/*.jsonl | tail -n +$((retention_count + 1)) | xargs rm -f
  log "Deleted $((session_count - retention_count)) old session logs"
}

# ── Main ────────────────────────────────────────────────────────────────────

log "Starting agent work log rotation"

# Ensure directories exist
ensure_dir "$LOG_DIR"
ensure_dir "$ARCHIVE_DIR"

# Rotate main stream log
if [ -f "$LOG_DIR/agent-work-stream.jsonl" ]; then
  STREAM_ARCHIVE="agent-work-stream-$(date +%Y%m%d).jsonl.gz"
  rotate_file "$LOG_DIR/agent-work-stream.jsonl" "$STREAM_ARCHIVE" "$STREAM_RETENTION_DAYS"
fi

# Rotate error log
if [ -f "$LOG_DIR/agent-errors.jsonl" ]; then
  ERROR_ARCHIVE="agent-errors-$(date +%Y%m%d).jsonl.gz"
  rotate_file "$LOG_DIR/agent-errors.jsonl" "$ERROR_ARCHIVE" "$ERROR_RETENTION_DAYS"
fi

# Rotate alerts log
if [ -f "$LOG_DIR/agent-alerts.jsonl" ]; then
  ALERTS_ARCHIVE="agent-alerts-$(date +%Y%m%d).jsonl.gz"
  rotate_file "$LOG_DIR/agent-alerts.jsonl" "$ALERTS_ARCHIVE" "$STREAM_RETENTION_DAYS"
fi

# Metrics log is kept indefinitely (compressed monthly)
if [ -f "$LOG_DIR/agent-metrics.jsonl" ]; then
  # Only rotate on first day of month
  if [ "$(date +%d)" = "01" ]; then
    METRICS_ARCHIVE="agent-metrics-$(date -d 'last month' +%Y%m).jsonl.gz"
    rotate_file "$LOG_DIR/agent-metrics.jsonl" "$METRICS_ARCHIVE" ""
  fi
fi

# Clean old session logs
clean_sessions "$SESSION_RETENTION_COUNT"

# Archive statistics
if [ -d "$ARCHIVE_DIR" ]; then
  archive_count=$(find "$ARCHIVE_DIR" -name "*.gz" -type f | wc -l)
  archive_size=$(du -sh "$ARCHIVE_DIR" 2>/dev/null | cut -f1 || echo "0")
  log "Archive directory: $archive_count files, $archive_size total"
fi

log "Agent work log rotation completed"
