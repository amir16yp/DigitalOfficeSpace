mod hub;
mod protocol;
mod world;
mod ws;

use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tower_http::services::{ServeDir, ServeFile};

use hub::{lobbies_dir, Hub};
use world::{Catalog, HEARING_RADIUS};
use ws::{ws_handler, AppState};

#[tokio::main]
async fn main() {
    let assets_dir = env_path("ASSETS_DIR", "assets");
    let data_dir = env_path("DATA_DIR", "data");
    let dist_dir = env_path("DIST_DIR", "client/dist");
    let port: u16 = env::var("PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(8080);

    let manifest = assets_dir.join("kenney").join("manifest.json");
    let catalog = Catalog::from_manifest(&manifest).unwrap_or_else(|err| {
        eprintln!("failed to load {manifest:?}: {err}");
        std::process::exit(1);
    });
    let hub = Hub::open(catalog, lobbies_dir(&data_dir));
    let app_state = AppState {
        hub: Arc::new(Mutex::new(hub)),
        assets_dir: assets_dir.clone(),
        ice: ice_servers(),
    };

    let ticker = app_state.hub.clone();
    tokio::spawn(async move {
        let mut frames = 0u32;
        loop {
            tokio::time::sleep(Duration::from_millis(50)).await;
            let mut hub = ticker.lock().await;
            frames += 1;
            hub.tick_all(0.05, frames % 2 == 0, frames % 20 == 0);
        }
    });

    let mut router = Router::new()
        .route("/ws", get(ws_handler))
        .route("/config", get(config))
        .route("/lobbies", get(list_lobbies).post(create_lobby))
        .route("/lobbies/:id", get(get_lobby))
        .route("/health", get(|| async { "ok" }))
        .nest_service("/assets", ServeDir::new(assets_dir))
        .with_state(app_state);

    let index = dist_dir.join("index.html");
    if index.exists() {
        let spa = ServeDir::new(dist_dir).not_found_service(ServeFile::new(index));
        router = router.fallback_service(spa);
    }

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    eprintln!("office listening on http://{addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap_or_else(|err| {
        eprintln!("bind {addr} failed: {err}");
        std::process::exit(1);
    });
    axum::serve(listener, router).await.unwrap();
}

async fn config(State(app): State<AppState>) -> Json<Value> {
    let pack = if app.assets_dir.join("limezu").join("manifest.json").exists() {
        "limezu"
    } else {
        "kenney"
    };
    Json(json!({
        "iceServers": app.ice,
        "hearingRadius": HEARING_RADIUS,
        "assetPack": pack,
    }))
}

async fn list_lobbies(State(app): State<AppState>) -> Json<Value> {
    let hub = app.hub.lock().await;
    Json(json!({ "lobbies": hub.list() }))
}

async fn get_lobby(
    State(app): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, StatusCode> {
    let hub = app.hub.lock().await;
    hub.info(&id)
        .map(|info| Json(json!(info)))
        .ok_or(StatusCode::NOT_FOUND)
}

#[derive(Deserialize)]
struct CreateBody {
    name: String,
    #[serde(default)]
    password: Option<String>,
}

async fn create_lobby(
    State(app): State<AppState>,
    Json(body): Json<CreateBody>,
) -> Json<Value> {
    let mut hub = app.hub.lock().await;
    let created = hub.create(&body.name, body.password);
    Json(json!({
        "id": created.id,
        "name": created.name,
        "hostToken": created.host_token,
    }))
}

fn ice_servers() -> Vec<Value> {
    let mut servers = Vec::new();
    if let Ok(stun) = env::var("STUN_URL") {
        if !stun.is_empty() {
            servers.push(json!({ "urls": stun }));
        }
    }
    if let Ok(turn) = env::var("TURN_URL") {
        if !turn.is_empty() {
            servers.push(json!({
                "urls": turn,
                "username": env::var("TURN_USER").unwrap_or_default(),
                "credential": env::var("TURN_PASSWORD").unwrap_or_default(),
            }));
        }
    }
    servers
}

fn env_path(key: &str, default: &str) -> PathBuf {
    env::var(key)
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(default))
}
