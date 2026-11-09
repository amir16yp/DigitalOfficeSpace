use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};

use crate::hub::Hub;
use crate::protocol::ServerMsg;
use crate::world::Outbound;

#[derive(Clone)]
pub struct AppState {
    pub hub: Arc<Mutex<Hub>>,
    pub assets_dir: std::path::PathBuf,
    pub ice: Vec<Value>,
}

pub async fn ws_handler(ws: WebSocketUpgrade, State(app): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle(socket, app))
}

async fn handle(socket: WebSocket, app: AppState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Outbound>();
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let message = match out {
                Outbound::Text(text) => Message::Text(text),
                Outbound::Pong(payload) => Message::Pong(payload),
            };
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    let mut joined: Option<(String, String, u64)> = None;
    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Text(text) => {
                if joined.is_none() {
                    match join_target(&text) {
                        Ok((lobby, password)) => {
                            let mut hub = app.hub.lock().await;
                            match hub.hello(&lobby, password.as_deref(), &text, tx.clone()) {
                                Ok(result) => {
                                    let _ = tx.send(Outbound::Text(result.welcome));
                                    joined = Some((lobby, result.id, result.generation));
                                }
                                Err(message) => {
                                    send_error(&tx, message);
                                    break;
                                }
                            }
                        }
                        Err(message) => {
                            send_error(&tx, message);
                            break;
                        }
                    }
                } else if let Some((lobby, id, generation)) = &joined {
                    let mut hub = app.hub.lock().await;
                    if hub.generation(lobby, id) != Some(*generation) {
                        break;
                    }
                    hub.on_message(lobby, id, &text);
                }
            }
            Message::Ping(payload) => {
                let _ = tx.send(Outbound::Pong(payload));
            }
            Message::Close(_) => break,
            Message::Pong(_) | Message::Binary(_) => {}
        }
    }

    if let Some((lobby, id, generation)) = joined {
        app.hub.lock().await.detach(&lobby, &id, generation);
    }
    drop(tx);
    writer.abort();
}

fn join_target(text: &str) -> Result<(String, Option<String>), String> {
    let value: Value = serde_json::from_str(text).map_err(|_| "expected hello".to_string())?;
    if value.get("type").and_then(|v| v.as_str()) != Some("hello") {
        return Err("expected hello".to_string());
    }
    let lobby = value
        .get("lobby")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if lobby.is_empty()
        || !lobby
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("choose a lobby".to_string());
    }
    let password = value
        .get("password")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty());
    Ok((lobby, password))
}

fn send_error(tx: &mpsc::UnboundedSender<Outbound>, message: String) {
    let err = serde_json::to_string(&ServerMsg::Error { message })
        .unwrap_or_else(|_| "{\"type\":\"error\"}".to_string());
    let _ = tx.send(Outbound::Text(err));
}
