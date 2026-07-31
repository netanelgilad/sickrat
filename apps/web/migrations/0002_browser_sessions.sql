CREATE TABLE IF NOT EXISTS browser_sessions (
	id TEXT PRIMARY KEY,
	resource_ref TEXT NOT NULL UNIQUE,
	artifact_object_key TEXT NOT NULL UNIQUE,
	artifact_etag TEXT,
	artifact_bytes INTEGER,
	wrapped_data_key TEXT NOT NULL,
	wrapped_data_key_iv TEXT NOT NULL,
	wrapped_data_key_kdf TEXT NOT NULL,
	encryption_algorithm TEXT NOT NULL,
	state TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	last_validated_at TEXT,
	expected_expires_at TEXT
);

CREATE TABLE IF NOT EXISTS browser_session_leases (
	id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	request_id TEXT NOT NULL UNIQUE,
	device_id TEXT NOT NULL,
	base_etag TEXT,
	access TEXT NOT NULL,
	capability_hash TEXT NOT NULL UNIQUE,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	downloaded_at TEXT,
	consumed_at TEXT,
	safe_reason_code TEXT,
	writer_slot TEXT,
	FOREIGN KEY(session_id) REFERENCES browser_sessions(id)
);

CREATE INDEX IF NOT EXISTS browser_sessions_state_idx
	ON browser_sessions(state, updated_at);

CREATE INDEX IF NOT EXISTS browser_session_leases_active_idx
	ON browser_session_leases(session_id, expires_at, consumed_at);

CREATE UNIQUE INDEX IF NOT EXISTS browser_session_single_writer_idx
	ON browser_session_leases(writer_slot)
	WHERE writer_slot IS NOT NULL;
