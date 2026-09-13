//! One small, durable bridge between a ChatGPT Web turn and a local WebCodex
//! project. The HTTP contract is intentionally provider-neutral: the selected
//! adapter is called asynchronously and every ambiguous outcome is retained.

use crate::auth::{AuthContext, SCOPE_COMMUNICATION_MANAGE, SCOPE_COMMUNICATION_READ};
use crate::db::{
    ChatSendStart, CommunicationPrincipal, NewChatSession, MAX_CHAT_MESSAGE_LIST_LIMIT,
};
use crate::route_metadata::{api_path, RouteId};
use crate::runtime_http::{parse_json_body, require_runtime};
use crate::tool_runtime::{communication_principal, ToolCall, ToolRuntime};
use salvo::prelude::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

const DEFAULT_PROVIDER_URL: &str = "http://127.0.0.1:17841";
const DEFAULT_PROVIDER_MODEL: &str = "chatgpt-web/medium";
const MAX_PROVIDER_ERROR_CHARS: usize = 1000;

pub(crate) fn routes() -> Router {
    Router::new().push(Router::with_path(api_path(RouteId::ChatSession)).post(chat_session))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum ChatSessionRequest {
    Create {
        title: String,
        project: String,
        #[serde(default)]
        model: Option<String>,
        idempotency_key: String,
    },
    Read {
        session_id: String,
        #[serde(default)]
        after_seq: Option<i64>,
        #[serde(default)]
        limit: Option<usize>,
    },
    Send {
        session_id: String,
        body: String,
        idempotency_key: String,
    },
    Operation {
        operation_id: String,
    },
}

#[handler]
async fn chat_session(req: &mut Request, depot: &mut Depot, res: &mut Response) {
    let Some(runtime) = require_runtime(depot, res) else {
        return;
    };
    let Some(request) = parse_json_body::<ChatSessionRequest>(req, res).await else {
        return;
    };
    let Ok(auth) = depot.obtain::<AuthContext>().cloned() else {
        render_error(
            res,
            StatusCode::INTERNAL_SERVER_ERROR,
            "Authentication context unavailable",
        );
        return;
    };
    let is_mutation = matches!(
        request,
        ChatSessionRequest::Create { .. } | ChatSessionRequest::Send { .. }
    );
    let allowed = if is_mutation {
        auth.has_scope(SCOPE_COMMUNICATION_READ) && auth.has_scope(SCOPE_COMMUNICATION_MANAGE)
    } else {
        auth.has_scope(SCOPE_COMMUNICATION_READ)
    };
    if !allowed {
        render_error(res, StatusCode::FORBIDDEN, "Chat session scope is required");
        return;
    }
    let principal = match communication_principal(Some(&auth)) {
        Ok(value) => value,
        Err(error) => {
            render_error(
                res,
                StatusCode::FORBIDDEN,
                error
                    .error
                    .as_deref()
                    .unwrap_or("Communication principal unavailable"),
            );
            return;
        }
    };
    let Some(db) = runtime.communication_db.clone() else {
        render_error(
            res,
            StatusCode::SERVICE_UNAVAILABLE,
            "Durable communication store is unavailable",
        );
        return;
    };

    match request {
        ChatSessionRequest::Create {
            title,
            project,
            model,
            idempotency_key,
        } => {
            let Some(project) = exact_project(&runtime, &auth, project).await else {
                render_error(
                    res,
                    StatusCode::NOT_FOUND,
                    "Project is not visible to this caller",
                );
                return;
            };
            let provider_url = provider_url();
            let model = model.unwrap_or_else(provider_model);
            match db.create_chat_session(
                &principal,
                NewChatSession {
                    title,
                    project_id: project,
                    provider_url,
                    model,
                    idempotency_key,
                },
            ) {
                Ok(value) => res.render(Json(json!({"session": value.session, "created": value.created, "replayed": value.replayed}))),
                Err(error) => render_store_error(res, error),
            }
        }
        ChatSessionRequest::Read {
            session_id,
            after_seq,
            limit,
        } => match db.read_chat_session(
            &principal,
            &session_id,
            after_seq.unwrap_or(0),
            limit.unwrap_or(MAX_CHAT_MESSAGE_LIST_LIMIT),
        ) {
            Ok(value) => res.render(Json(value)),
            Err(error) => render_store_error(res, error),
        },
        ChatSessionRequest::Operation { operation_id } => {
            match db.read_chat_operation(&principal, &operation_id) {
                Ok(value) => res.render(Json(value)),
                Err(error) => render_store_error(res, error),
            }
        }
        ChatSessionRequest::Send {
            session_id,
            body,
            idempotency_key,
        } => match db.begin_chat_send(&principal, &session_id, &body, &idempotency_key) {
            Ok(ChatSendStart::Existing(value)) => res.render(Json(value)),
            Ok(ChatSendStart::Started(envelope)) => {
                let operation_id = envelope.operation_id.clone();
                let session_id = envelope.session_id.clone();
                let task_db = db.clone();
                let task_principal = principal.clone();
                tokio::spawn(async move {
                    run_provider(task_db, task_principal, envelope).await;
                });
                res.status_code(StatusCode::ACCEPTED);
                res.render(Json(json!({
                    "operation_id": operation_id,
                    "session_id": session_id,
                    "state": "pending",
                    "poll": "operation",
                })));
            }
            Err(error) => render_store_error(res, error),
        },
    }
}

async fn exact_project(
    runtime: &ToolRuntime,
    auth: &AuthContext,
    project: String,
) -> Option<String> {
    let result = runtime
        .dispatch_with_auth(
            ToolCall::ListProjects {
                client_id: None,
                project: Some(project.clone()),
                query: None,
                limit: Some(2),
                summary_only: true,
            },
            Some(auth),
        )
        .await;
    result.success.then(|| {
        result.output["projects"]
            .as_array()
            .and_then(|items| items.iter().find(|item| item["id"] == project))
            .and_then(|item| item["id"].as_str())
            .map(str::to_string)
    })?
}

fn provider_url() -> String {
    std::env::var("WEBCODEX_CHATGPT_WEB_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .unwrap_or_else(|| DEFAULT_PROVIDER_URL.to_string())
}

fn provider_model() -> String {
    std::env::var("WEBCODEX_CHATGPT_WEB_MODEL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .unwrap_or_else(|| DEFAULT_PROVIDER_MODEL.to_string())
}

async fn run_provider(
    db: Arc<crate::Database>,
    principal: CommunicationPrincipal,
    envelope: crate::db::ChatSendEnvelope,
) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            let _ = db.fail_chat_send(
                &principal,
                &envelope.operation_id,
                "provider_client_error",
                &bounded_error(error.to_string()),
                true,
            );
            return;
        }
    };
    let mut request = client.post(format!("{}/v1/responses", envelope.provider_url));
    if let Ok(token) = std::env::var("WEBCODEX_CHATGPT_WEB_TOKEN") {
        if !token.trim().is_empty() {
            request = request.bearer_auth(token);
        }
    }
    let mut payload = json!({
        "model": envelope.model,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": envelope.user_body}]}],
        "stream": false,
        "metadata": {"webcodex_session_id": envelope.session_id, "webcodex_project_id": envelope.project_id},
    });
    if let Some(previous_response_id) = envelope.previous_response_id {
        payload["previous_response_id"] = Value::String(previous_response_id);
    }
    let response = match request.json(&payload).send().await {
        Ok(response) => response,
        Err(error) => {
            let _ = db.fail_chat_send(
                &principal,
                &envelope.operation_id,
                "provider_request_error",
                &bounded_error(error.to_string()),
                true,
            );
            return;
        }
    };
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let _ = db.fail_chat_send(
            &principal,
            &envelope.operation_id,
            "provider_http_error",
            &bounded_error(format!("HTTP {status}: {body}")),
            true,
        );
        return;
    }
    let body: Value = match response.json().await {
        Ok(value) => value,
        Err(error) => {
            let _ = db.fail_chat_send(
                &principal,
                &envelope.operation_id,
                "provider_invalid_json",
                &bounded_error(error.to_string()),
                true,
            );
            return;
        }
    };
    let response_id = body["id"].as_str().map(str::to_string);
    let Some(text) = response_text(&body) else {
        let _ = db.fail_chat_send(
            &principal,
            &envelope.operation_id,
            "provider_empty_response",
            "Provider response contained no assistant text",
            true,
        );
        return;
    };
    let _ = db.complete_chat_send(
        &principal,
        &envelope.operation_id,
        response_id.as_deref(),
        &text,
    );
}

fn response_text(body: &Value) -> Option<String> {
    if let Some(text) = body["output_text"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
    {
        return Some(text.to_string());
    }
    body["output"]
        .as_array()?
        .iter()
        .flat_map(|item| item["content"].as_array())
        .flatten()
        .find_map(|item| {
            item["text"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .map(str::to_string)
        })
}

fn bounded_error(value: String) -> String {
    value.chars().take(MAX_PROVIDER_ERROR_CHARS).collect()
}

fn render_store_error(res: &mut Response, error: crate::db::CommunicationStoreError) {
    let status = match error.code() {
        "chat_session_not_found" | "chat_operation_not_found" => StatusCode::NOT_FOUND,
        "chat_operation_conflict" | "chat_session_busy" | "chat_session_closed" => {
            StatusCode::CONFLICT
        }
        "chat_session_store_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::BAD_REQUEST,
    };
    res.status_code(status);
    res.render(Json(
        json!({"error_kind": error.code(), "message": error.message(), "state_changed": false}),
    ));
}

fn render_error(res: &mut Response, status: StatusCode, message: &str) {
    res.status_code(status);
    res.render(crate::json_error(status, message));
}
