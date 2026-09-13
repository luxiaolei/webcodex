use super::communication::{CommunicationPrincipal, CommunicationStoreError};
use super::Database;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use uuid::Uuid;

pub const CHAT_SESSION_ID_PREFIX: &str = "wc_chat_";
pub const CHAT_OPERATION_ID_PREFIX: &str = "wc_chat_op_";
pub const MAX_CHAT_SESSION_TITLE_CHARS: usize = 200;
pub const MAX_CHAT_MESSAGE_BYTES: usize = 32_768;
pub const MAX_CHAT_PROVIDER_URL_CHARS: usize = 512;
pub const MAX_CHAT_WEB_PROJECT_URL_CHARS: usize = 512;
pub const MAX_CHAT_MODEL_CHARS: usize = 128;
pub const MAX_CHAT_MESSAGE_LIST_LIMIT: usize = 100;

#[derive(Debug, Clone)]
pub struct NewChatSession {
    pub title: String,
    pub project_id: String,
    pub web_project_url: Option<String>,
    pub provider_url: String,
    pub model: String,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChatSessionState {
    Active,
    Waiting,
    Unknown,
    Closed,
}

impl ChatSessionState {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Waiting => "waiting",
            Self::Unknown => "unknown",
            Self::Closed => "closed",
        }
    }

    fn from_db(value: &str) -> Result<Self, rusqlite::Error> {
        match value {
            "active" => Ok(Self::Active),
            "waiting" => Ok(Self::Waiting),
            "unknown" => Ok(Self::Unknown),
            "closed" => Ok(Self::Closed),
            other => Err(rusqlite::Error::InvalidParameterName(format!(
                "unsupported chat session state: {other}"
            ))),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatSessionSummary {
    pub session_id: String,
    pub title: String,
    pub project_id: String,
    pub web_project_url: Option<String>,
    pub model: String,
    pub state: ChatSessionState,
    pub latest_response_id: Option<String>,
    pub message_count: i64,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatSessionMessage {
    pub message_id: String,
    pub seq: i64,
    pub role: String,
    pub body: String,
    pub created_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatSessionDetail {
    pub summary: ChatSessionSummary,
    pub messages: Vec<ChatSessionMessage>,
    pub next_after_seq: i64,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatSessionMutation {
    pub session: ChatSessionSummary,
    pub created: bool,
    pub replayed: bool,
    pub state_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatOperationStatus {
    pub operation_id: String,
    pub session_id: String,
    pub state: String,
    pub response_id: Option<String>,
    pub assistant_body: Option<String>,
    pub error_kind: Option<String>,
    pub error_message: Option<String>,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

#[derive(Debug, Clone)]
pub struct ChatSendEnvelope {
    pub operation_id: String,
    pub session_id: String,
    pub project_id: String,
    pub web_project_url: Option<String>,
    pub provider_url: String,
    pub model: String,
    pub previous_response_id: Option<String>,
    pub user_body: String,
}

#[derive(Debug, Clone)]
pub enum ChatSendStart {
    Started(ChatSendEnvelope),
    Existing(ChatOperationStatus),
}

fn now_unix_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn store_error(error: rusqlite::Error) -> CommunicationStoreError {
    CommunicationStoreError::new(
        "chat_session_store_unavailable",
        format!("Chat session store is unavailable: {error}"),
    )
}

fn invalid(message: impl Into<String>) -> CommunicationStoreError {
    CommunicationStoreError::new("invalid_chat_session", message)
}

fn validate_principal(principal: &CommunicationPrincipal) -> Result<(), CommunicationStoreError> {
    if principal.kind.trim().is_empty() || principal.digest.trim().is_empty() {
        return Err(invalid("communication principal is invalid"));
    }
    Ok(())
}

fn validate_text(value: &str, max: usize, field: &str) -> Result<String, CommunicationStoreError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control) {
        return Err(invalid(format!("{field} is empty or exceeds its bound")));
    }
    Ok(value.to_string())
}

fn validate_body(value: &str) -> Result<String, CommunicationStoreError> {
    if value.trim().is_empty() || value.len() > MAX_CHAT_MESSAGE_BYTES {
        return Err(invalid("message body is empty or exceeds its byte bound"));
    }
    Ok(value.to_string())
}

fn validate_web_project_url(
    value: Option<String>,
) -> Result<Option<String>, CommunicationStoreError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = validate_text(&value, MAX_CHAT_WEB_PROJECT_URL_CHARS, "web_project_url")?;
    let parsed = url::Url::parse(&value)
        .map_err(|_| invalid("web_project_url must be an absolute URL"))?;
    let host = parsed.host_str().unwrap_or_default();
    if parsed.scheme() != "https"
        || !matches!(host, "chatgpt.com" | "www.chatgpt.com" | "chat.openai.com")
        || parsed.username() != ""
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.path().starts_with("/g/")
        || !parsed.path().ends_with("/project")
    {
        return Err(invalid(
            "web_project_url must be an https ChatGPT Project URL ending in /project",
        ));
    }
    Ok(Some(value))
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}{}", Uuid::new_v4().simple())
}

fn hash_request(session_id: &str, body: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"webcodex.chat-session.send.v1\0");
    hash.update(session_id.as_bytes());
    hash.update([0]);
    hash.update(body.as_bytes());
    format!("{:x}", hash.finalize())
}

fn hash_create(
    title: &str,
    project_id: &str,
    web_project_url: Option<&str>,
    provider_url: &str,
    model: &str,
) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(b"webcodex.chat-session.create.v1\0");
    for value in [title, project_id, web_project_url.unwrap_or(""), provider_url, model] {
        hash.update(value.as_bytes());
        hash.update([0]);
    }
    format!("{:x}", hash.finalize())
}

impl Database {
    pub(crate) fn ensure_chat_session_schema(
        conn: &mut rusqlite::Connection,
    ) -> anyhow::Result<()> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS wc_chat_sessions (
                session_id TEXT PRIMARY KEY,
                owner_principal_kind TEXT NOT NULL,
                owner_principal_digest TEXT NOT NULL,
                title TEXT NOT NULL,
                project_id TEXT NOT NULL,
                provider_url TEXT NOT NULL,
                model TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('active', 'waiting', 'unknown', 'closed')),
                latest_response_id TEXT,
                created_at_unix_ms INTEGER NOT NULL,
                updated_at_unix_ms INTEGER NOT NULL,
                web_project_url TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_wc_chat_sessions_owner_updated
                ON wc_chat_sessions(owner_principal_digest, updated_at_unix_ms DESC, session_id);
            CREATE TABLE IF NOT EXISTS wc_chat_session_messages (
                message_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                seq INTEGER NOT NULL CHECK(seq >= 1),
                role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
                body TEXT NOT NULL,
                created_at_unix_ms INTEGER NOT NULL,
                UNIQUE(session_id, seq),
                FOREIGN KEY(session_id) REFERENCES wc_chat_sessions(session_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_wc_chat_session_messages_session_seq
                ON wc_chat_session_messages(session_id, seq);
            CREATE TABLE IF NOT EXISTS wc_chat_session_operations (
                operation_id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                owner_principal_digest TEXT NOT NULL,
                idempotency_key TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('pending', 'completed', 'failed', 'unknown')),
                response_id TEXT,
                assistant_body TEXT,
                error_kind TEXT,
                error_message TEXT,
                created_at_unix_ms INTEGER NOT NULL,
                updated_at_unix_ms INTEGER NOT NULL,
                UNIQUE(owner_principal_digest, idempotency_key),
                FOREIGN KEY(session_id) REFERENCES wc_chat_sessions(session_id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_wc_chat_session_operations_session_updated
                ON wc_chat_session_operations(session_id, updated_at_unix_ms DESC, operation_id);
            UPDATE wc_chat_session_operations
               SET state = 'unknown',
                   error_kind = 'server_restart',
                   error_message = 'Provider operation was in flight when WebCodex restarted',
                   updated_at_unix_ms = CAST(strftime('%s','now') AS INTEGER) * 1000
             WHERE state = 'pending';
            UPDATE wc_chat_sessions
               SET state = 'unknown',
                   updated_at_unix_ms = CAST(strftime('%s','now') AS INTEGER) * 1000
             WHERE state = 'waiting';
            ",
        )?;
        let has_web_project_url = conn
            .prepare("PRAGMA table_info(wc_chat_sessions)")?
            .query_map([], |row| row.get::<_, String>(1))?
            .any(|column| column.as_deref() == Ok("web_project_url"));
        if !has_web_project_url {
            conn.execute(
                "ALTER TABLE wc_chat_sessions ADD COLUMN web_project_url TEXT",
                [],
            )?;
        }
        Ok(())
    }

    pub fn create_chat_session(
        &self,
        principal: &CommunicationPrincipal,
        input: NewChatSession,
    ) -> Result<ChatSessionMutation, CommunicationStoreError> {
        validate_principal(principal)?;
        let title = validate_text(&input.title, MAX_CHAT_SESSION_TITLE_CHARS, "title")?;
        let project_id = validate_text(&input.project_id, 512, "project_id")?;
        let web_project_url = validate_web_project_url(input.web_project_url)?;
        let provider_url = validate_text(
            &input.provider_url,
            MAX_CHAT_PROVIDER_URL_CHARS,
            "provider_url",
        )?;
        if !(provider_url.starts_with("http://") || provider_url.starts_with("https://")) {
            return Err(invalid("provider_url must use http or https"));
        }
        let model = validate_text(&input.model, MAX_CHAT_MODEL_CHARS, "model")?;
        let idempotency_key = validate_text(&input.idempotency_key, 128, "idempotency_key")?;
        let create_key = format!("create:{idempotency_key}");
        let request_hash = hash_create(
            &title,
            &project_id,
            web_project_url.as_deref(),
            &provider_url,
            &model,
        );
        let now = now_unix_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| invalid("database lock poisoned"))?;
        let tx = conn.unchecked_transaction().map_err(store_error)?;
        if let Some(existing) = tx
            .query_row(
                "SELECT s.session_id, s.title, s.project_id, s.provider_url, s.model, s.state, s.latest_response_id, s.created_at_unix_ms, s.updated_at_unix_ms, s.web_project_url, o.request_hash FROM wc_chat_sessions s JOIN wc_chat_session_operations o ON o.session_id = s.session_id WHERE s.owner_principal_digest = ?1 AND o.owner_principal_digest = ?1 AND o.idempotency_key = ?2",
                params![principal.digest, create_key],
                |row| {
                    let summary = row_to_summary(row, 0)?;
                    let request_hash: String = row.get(10)?;
                    Ok((summary, request_hash))
                },
            )
            .optional()
            .map_err(store_error)?
        {
            if existing.1 != request_hash {
                return Err(CommunicationStoreError::new("chat_operation_conflict", "Idempotency key was reused with different session input"));
            }
            return Ok(ChatSessionMutation { session: existing.0, created: false, replayed: true, state_changed: false });
        }
        let session_id = new_id(CHAT_SESSION_ID_PREFIX);
        tx.execute(
            "INSERT INTO wc_chat_sessions(session_id, owner_principal_kind, owner_principal_digest, title, project_id, provider_url, model, state, created_at_unix_ms, updated_at_unix_ms, web_project_url) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?8, ?9)",
            params![session_id, principal.kind, principal.digest, title, project_id, provider_url, model, now, web_project_url],
        )
        .map_err(store_error)?;
        tx.execute(
            "INSERT INTO wc_chat_session_operations(operation_id, session_id, owner_principal_digest, idempotency_key, request_hash, state, created_at_unix_ms, updated_at_unix_ms) VALUES (?1, ?2, ?3, ?4, ?5, 'completed', ?6, ?6)",
            params![new_id(CHAT_OPERATION_ID_PREFIX), session_id, principal.digest, create_key, request_hash, now],
        )
        .map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        Ok(ChatSessionMutation {
            session: ChatSessionSummary {
                session_id,
                title,
                project_id,
                web_project_url,
                model,
                state: ChatSessionState::Active,
                latest_response_id: None,
                message_count: 0,
                created_at_unix_ms: now,
                updated_at_unix_ms: now,
            },
            created: true,
            replayed: false,
            state_changed: true,
        })
    }

    pub fn read_chat_session(
        &self,
        principal: &CommunicationPrincipal,
        session_id: &str,
        after_seq: i64,
        limit: usize,
    ) -> Result<ChatSessionDetail, CommunicationStoreError> {
        validate_principal(principal)?;
        if !session_id.starts_with(CHAT_SESSION_ID_PREFIX) || after_seq < 0 || limit == 0 {
            return Err(invalid("chat session cursor or id is invalid"));
        }
        let limit = limit.min(MAX_CHAT_MESSAGE_LIST_LIMIT);
        let conn = self
            .conn
            .lock()
            .map_err(|_| invalid("database lock poisoned"))?;
        let mut summary = conn
            .query_row(
                "SELECT session_id, title, project_id, provider_url, model, state, latest_response_id, created_at_unix_ms, updated_at_unix_ms, web_project_url FROM wc_chat_sessions WHERE session_id = ?1 AND owner_principal_digest = ?2",
                params![session_id, principal.digest],
                |row| row_to_summary(row, 0),
            )
            .optional()
            .map_err(store_error)?
            .ok_or_else(|| CommunicationStoreError::new("chat_session_not_found", "Chat session not found"))?;
        summary.message_count = conn
            .query_row(
                "SELECT COUNT(*) FROM wc_chat_session_messages WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .map_err(store_error)?;
        let mut stmt = conn
            .prepare("SELECT message_id, seq, role, body, created_at_unix_ms FROM wc_chat_session_messages WHERE session_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3")
            .map_err(store_error)?;
        let messages = stmt
            .query_map(params![session_id, after_seq, limit as i64], |row| {
                Ok(ChatSessionMessage {
                    message_id: row.get(0)?,
                    seq: row.get(1)?,
                    role: row.get(2)?,
                    body: row.get(3)?,
                    created_at_unix_ms: row.get(4)?,
                })
            })
            .map_err(store_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(store_error)?;
        let next_after_seq = messages
            .last()
            .map(|message| message.seq)
            .unwrap_or(after_seq);
        let truncated = messages.len() == limit;
        Ok(ChatSessionDetail {
            summary,
            messages,
            next_after_seq,
            truncated,
        })
    }

    pub fn begin_chat_send(
        &self,
        principal: &CommunicationPrincipal,
        session_id: &str,
        body: &str,
        idempotency_key: &str,
    ) -> Result<ChatSendStart, CommunicationStoreError> {
        validate_principal(principal)?;
        let body = validate_body(body)?;
        let idempotency_key = validate_text(idempotency_key, 128, "idempotency_key")?;
        let request_hash = hash_request(session_id, &body);
        let now = now_unix_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| invalid("database lock poisoned"))?;
        let tx = conn.unchecked_transaction().map_err(store_error)?;
        if let Some(existing) = tx
            .query_row(
                "SELECT operation_id, session_id, state, response_id, assistant_body, error_kind, error_message, created_at_unix_ms, updated_at_unix_ms FROM wc_chat_session_operations WHERE owner_principal_digest = ?1 AND idempotency_key = ?2",
                params![principal.digest, idempotency_key],
                row_to_operation,
            )
            .optional()
            .map_err(store_error)?
        {
            let existing_hash: String = tx
                .query_row("SELECT request_hash FROM wc_chat_session_operations WHERE operation_id = ?1", params![existing.operation_id], |row| row.get(0))
                .map_err(store_error)?;
            if existing_hash != request_hash {
                return Err(CommunicationStoreError::new("chat_operation_conflict", "Idempotency key was reused with different input"));
            }
            tx.commit().map_err(store_error)?;
            return Ok(ChatSendStart::Existing(existing));
        }
        let (project_id, provider_url, model, previous_response_id, state, web_project_url): (String, String, String, Option<String>, String, Option<String>) = tx
            .query_row(
                "SELECT title, project_id, provider_url, model, latest_response_id, state, web_project_url FROM wc_chat_sessions WHERE session_id = ?1 AND owner_principal_digest = ?2",
                params![session_id, principal.digest],
                |row| Ok((row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?, row.get(6)?)),
            )
            .map_err(|error| match error { rusqlite::Error::QueryReturnedNoRows => CommunicationStoreError::new("chat_session_not_found", "Chat session not found"), other => store_error(other) })?;
        if state == "closed" {
            return Err(CommunicationStoreError::new(
                "chat_session_closed",
                "Chat session is closed",
            ));
        }
        if state == "waiting" || state == "unknown" {
            return Err(CommunicationStoreError::new(
                "chat_session_busy",
                "Chat session requires operation reconciliation before another send",
            ));
        }
        let seq: i64 = tx
            .query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM wc_chat_session_messages WHERE session_id = ?1", params![session_id], |row| row.get(0))
            .map_err(store_error)?;
        tx.execute("INSERT INTO wc_chat_session_messages(message_id, session_id, seq, role, body, created_at_unix_ms) VALUES (?1, ?2, ?3, 'user', ?4, ?5)", params![new_id("wc_chat_msg_"), session_id, seq, body, now]).map_err(store_error)?;
        let operation_id = new_id(CHAT_OPERATION_ID_PREFIX);
        tx.execute("INSERT INTO wc_chat_session_operations(operation_id, session_id, owner_principal_digest, idempotency_key, request_hash, state, created_at_unix_ms, updated_at_unix_ms) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6)", params![operation_id, session_id, principal.digest, idempotency_key, request_hash, now]).map_err(store_error)?;
        tx.execute("UPDATE wc_chat_sessions SET state = 'waiting', updated_at_unix_ms = ?2 WHERE session_id = ?1", params![session_id, now]).map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        Ok(ChatSendStart::Started(ChatSendEnvelope {
            operation_id,
            session_id: session_id.to_string(),
            project_id,
            web_project_url,
            provider_url,
            model,
            previous_response_id,
            user_body: body,
        }))
    }

    pub fn complete_chat_send(
        &self,
        principal: &CommunicationPrincipal,
        operation_id: &str,
        response_id: Option<&str>,
        assistant_body: &str,
    ) -> Result<ChatOperationStatus, CommunicationStoreError> {
        self.finish_chat_send(
            principal,
            operation_id,
            response_id,
            Some(assistant_body),
            None,
            "completed",
        )
    }

    pub fn fail_chat_send(
        &self,
        principal: &CommunicationPrincipal,
        operation_id: &str,
        error_kind: &str,
        error_message: &str,
        unknown: bool,
    ) -> Result<ChatOperationStatus, CommunicationStoreError> {
        self.finish_chat_send(
            principal,
            operation_id,
            None,
            None,
            Some((error_kind, error_message)),
            if unknown { "unknown" } else { "failed" },
        )
    }

    fn finish_chat_send(
        &self,
        principal: &CommunicationPrincipal,
        operation_id: &str,
        response_id: Option<&str>,
        assistant_body: Option<&str>,
        error: Option<(&str, &str)>,
        state: &str,
    ) -> Result<ChatOperationStatus, CommunicationStoreError> {
        validate_principal(principal)?;
        let now = now_unix_ms();
        let conn = self
            .conn
            .lock()
            .map_err(|_| invalid("database lock poisoned"))?;
        let tx = conn.unchecked_transaction().map_err(store_error)?;
        let existing = tx.query_row("SELECT operation_id, session_id, state, response_id, assistant_body, error_kind, error_message, created_at_unix_ms, updated_at_unix_ms FROM wc_chat_session_operations WHERE operation_id = ?1 AND owner_principal_digest = ?2", params![operation_id, principal.digest], row_to_operation).optional().map_err(store_error)?.ok_or_else(|| CommunicationStoreError::new("chat_operation_not_found", "Chat operation not found"))?;
        if existing.state != "pending" {
            tx.commit().map_err(store_error)?;
            return Ok(existing);
        }
        if state == "completed" {
            let seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM wc_chat_session_messages WHERE session_id = ?1", params![existing.session_id], |row| row.get(0)).map_err(store_error)?;
            tx.execute("INSERT INTO wc_chat_session_messages(message_id, session_id, seq, role, body, created_at_unix_ms) VALUES (?1, ?2, ?3, 'assistant', ?4, ?5)", params![new_id("wc_chat_msg_"), existing.session_id, seq, assistant_body.unwrap_or_default(), now]).map_err(store_error)?;
        }
        let (error_kind, error_message) = error.unwrap_or(("", ""));
        tx.execute("UPDATE wc_chat_session_operations SET state = ?2, response_id = ?3, assistant_body = ?4, error_kind = NULLIF(?5, ''), error_message = NULLIF(?6, ''), updated_at_unix_ms = ?7 WHERE operation_id = ?1", params![operation_id, state, response_id, assistant_body, error_kind, error_message, now]).map_err(store_error)?;
        let session_state = if state == "completed" {
            "active"
        } else if state == "unknown" {
            "unknown"
        } else {
            "active"
        };
        tx.execute("UPDATE wc_chat_sessions SET state = ?2, latest_response_id = COALESCE(?3, latest_response_id), updated_at_unix_ms = ?4 WHERE session_id = ?1", params![existing.session_id, session_state, response_id, now]).map_err(store_error)?;
        tx.commit().map_err(store_error)?;
        Ok(ChatOperationStatus {
            operation_id: operation_id.to_string(),
            session_id: existing.session_id,
            state: state.to_string(),
            response_id: response_id.map(str::to_string),
            assistant_body: assistant_body.map(str::to_string),
            error_kind: (!error_kind.is_empty()).then(|| error_kind.to_string()),
            error_message: (!error_message.is_empty()).then(|| error_message.to_string()),
            created_at_unix_ms: existing.created_at_unix_ms,
            updated_at_unix_ms: now,
        })
    }

    pub fn read_chat_operation(
        &self,
        principal: &CommunicationPrincipal,
        operation_id: &str,
    ) -> Result<ChatOperationStatus, CommunicationStoreError> {
        validate_principal(principal)?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| invalid("database lock poisoned"))?;
        conn.query_row("SELECT operation_id, session_id, state, response_id, assistant_body, error_kind, error_message, created_at_unix_ms, updated_at_unix_ms FROM wc_chat_session_operations WHERE operation_id = ?1 AND owner_principal_digest = ?2", params![operation_id, principal.digest], row_to_operation)
            .optional().map_err(store_error)?.ok_or_else(|| CommunicationStoreError::new("chat_operation_not_found", "Chat operation not found"))
    }
}

fn row_to_summary(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<ChatSessionSummary> {
    Ok(ChatSessionSummary {
        session_id: row.get(offset)?,
        title: row.get(offset + 1)?,
        project_id: row.get(offset + 2)?,
        web_project_url: row.get(offset + 9)?,
        model: row.get(offset + 4)?,
        state: ChatSessionState::from_db(&row.get::<_, String>(offset + 5)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                offset + 5,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        latest_response_id: row.get(offset + 6)?,
        message_count: 0,
        created_at_unix_ms: row.get(offset + 7)?,
        updated_at_unix_ms: row.get(offset + 8)?,
    })
}

fn row_to_operation(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChatOperationStatus> {
    Ok(ChatOperationStatus {
        operation_id: row.get(0)?,
        session_id: row.get(1)?,
        state: row.get(2)?,
        response_id: row.get(3)?,
        assistant_body: row.get(4)?,
        error_kind: row.get(5)?,
        error_message: row.get(6)?,
        created_at_unix_ms: row.get(7)?,
        updated_at_unix_ms: row.get(8)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn send_unknown_is_durable_and_blocks_blind_retry() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("state.sqlite")).unwrap();
        let principal = CommunicationPrincipal {
            kind: "test".into(),
            digest: "wc_principal_test".into(),
        };
        let created = db
            .create_chat_session(
                &principal,
                NewChatSession {
                    title: "test".into(),
                    project_id: "runner/project".into(),
                    web_project_url: None,
                    provider_url: "http://127.0.0.1:17841".into(),
                    model: "chatgpt-web/medium".into(),
                    idempotency_key: "create-1".into(),
                },
            )
            .unwrap();
        let replay = db
            .create_chat_session(
                &principal,
                NewChatSession {
                    title: "test".into(),
                    project_id: "runner/project".into(),
                    web_project_url: None,
                    provider_url: "http://127.0.0.1:17841".into(),
                    model: "chatgpt-web/medium".into(),
                    idempotency_key: "create-1".into(),
                },
            )
            .unwrap();
        assert!(replay.replayed);
        let session_id = created.session.session_id;
        let operation = match db
            .begin_chat_send(&principal, &session_id, "compute", "send-1")
            .unwrap()
        {
            ChatSendStart::Started(value) => value,
            ChatSendStart::Existing(_) => panic!("first send must start"),
        };
        let status = db
            .fail_chat_send(
                &principal,
                &operation.operation_id,
                "provider_timeout",
                "outcome uncertain",
                true,
            )
            .unwrap();
        assert_eq!(status.state, "unknown");
        let detail = db
            .read_chat_session(&principal, &session_id, 0, 10)
            .unwrap();
        assert_eq!(detail.summary.state, ChatSessionState::Unknown);
        assert_eq!(detail.summary.message_count, 1);
        assert!(matches!(
            db.begin_chat_send(&principal, &session_id, "retry", "send-2"),
            Err(error) if error.code() == "chat_session_busy"
        ));
    }

    #[test]
    fn chat_session_preserves_web_project_binding_for_provider_navigation() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("state.sqlite")).unwrap();
        let principal = CommunicationPrincipal {
            kind: "test".into(),
            digest: "wc_principal_web_project".into(),
        };
        let web_project_url = "https://chatgpt.com/g/g-p-demo-project/project".to_string();
        let created = db
            .create_chat_session(
                &principal,
                NewChatSession {
                    title: "project chat".into(),
                    project_id: "runner/project".into(),
                    web_project_url: Some(web_project_url.clone()),
                    provider_url: "http://127.0.0.1:17841".into(),
                    model: "chatgpt-web/medium".into(),
                    idempotency_key: "create-web-project-1".into(),
                },
            )
            .unwrap();
        assert_eq!(created.session.web_project_url.as_deref(), Some(web_project_url.as_str()));

        let envelope = match db
            .begin_chat_send(
                &principal,
                &created.session.session_id,
                "hello project",
                "send-web-project-1",
            )
            .unwrap()
        {
            ChatSendStart::Started(value) => value,
            ChatSendStart::Existing(_) => panic!("first send must start"),
        };
        assert_eq!(envelope.web_project_url.as_deref(), Some(web_project_url.as_str()));
    }

    #[test]
    fn chat_session_rejects_non_chatgpt_web_project_url() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("state.sqlite")).unwrap();
        let principal = CommunicationPrincipal {
            kind: "test".into(),
            digest: "wc_principal_invalid_web_project".into(),
        };
        let result = db.create_chat_session(
            &principal,
            NewChatSession {
                title: "invalid project chat".into(),
                project_id: "runner/project".into(),
                web_project_url: Some("https://example.com/project".into()),
                provider_url: "http://127.0.0.1:17841".into(),
                model: "chatgpt-web/medium".into(),
                idempotency_key: "create-invalid-web-project-1".into(),
            },
        );
        assert!(matches!(result, Err(error) if error.code() == "invalid_chat_session"));
    }
}
