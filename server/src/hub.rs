use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::world::{HelloResult, Outbound, World, Catalog};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LobbyInfo {
    pub id: String,
    pub name: String,
    pub players: usize,
    pub has_password: bool,
}

pub struct CreatedLobby {
    pub id: String,
    pub name: String,
    pub host_token: String,
}

pub struct Hub {
    catalog: Catalog,
    dir: PathBuf,
    lobbies: HashMap<String, World>,
}

impl Hub {
    pub fn open(catalog: Catalog, dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&dir);
        let mut lobbies = HashMap::new();
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|s| s.to_str()) != Some("json") {
                    continue;
                }
                match World::load(catalog.clone(), path.clone()) {
                    Ok(world) => {
                        lobbies.insert(world.id.clone(), world);
                    }
                    Err(err) => eprintln!("skipping {}: {err}", path.display()),
                }
            }
        }
        Self {
            catalog,
            dir,
            lobbies,
        }
    }

    pub fn list(&self) -> Vec<LobbyInfo> {
        let mut list: Vec<LobbyInfo> = self.lobbies.values().map(info).collect();
        list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
        list
    }

    pub fn info(&self, id: &str) -> Option<LobbyInfo> {
        self.lobbies.get(id).map(info)
    }

    pub fn create(&mut self, name: &str, password: Option<String>) -> CreatedLobby {
        let name = clean_lobby_name(name);
        let password = password
            .map(|p| p.chars().filter(|c| !c.is_control()).take(64).collect::<String>())
            .filter(|p| !p.is_empty());
        let id = self.fresh_id();
        let path = self.dir.join(format!("{id}.json"));
        let world = World::create(self.catalog.clone(), id.clone(), name.clone(), password, path);
        let host_token = world.host_token().unwrap_or("").to_string();
        self.lobbies.insert(id.clone(), world);
        CreatedLobby {
            id,
            name,
            host_token,
        }
    }

    pub fn hello(
        &mut self,
        lobby: &str,
        password: Option<&str>,
        text: &str,
        tx: UnboundedSender<Outbound>,
    ) -> Result<HelloResult, String> {
        let world = self
            .lobbies
            .get_mut(lobby)
            .ok_or_else(|| "that lobby is gone".to_string())?;
        if !world.password_ok(password) {
            return Err("wrong password".to_string());
        }
        world.hello(text, tx)
    }

    pub fn generation(&self, lobby: &str, id: &str) -> Option<u64> {
        self.lobbies.get(lobby)?.generation(id)
    }

    pub fn on_message(&mut self, lobby: &str, id: &str, text: &str) {
        if let Some(world) = self.lobbies.get_mut(lobby) {
            world.on_message(id, text);
        }
    }

    pub fn detach(&mut self, lobby: &str, id: &str, generation: u64) {
        if let Some(world) = self.lobbies.get_mut(lobby) {
            world.detach(id, generation);
        }
    }

    pub fn tick_all(&mut self, dt: f32, publish: bool, sweep: bool) {
        for world in self.lobbies.values_mut() {
            world.tick(dt);
            if publish {
                world.broadcast_snapshot();
                world.broadcast_hearing();
            }
            if sweep {
                world.sweep();
            }
        }
    }

    fn fresh_id(&self) -> String {
        loop {
            let raw = Uuid::new_v4().to_string();
            let id = raw[..8].to_string();
            let path = self.dir.join(format!("{id}.json"));
            if !self.lobbies.contains_key(&id) && !path.exists() {
                return id;
            }
        }
    }
}

fn info(world: &World) -> LobbyInfo {
    LobbyInfo {
        id: world.id.clone(),
        name: world.name.clone(),
        players: world.connected_count(),
        has_password: world.has_password(),
    }
}

fn clean_lobby_name(raw: &str) -> String {
    let name: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(32)
        .collect::<String>()
        .trim()
        .to_string();
    if name.is_empty() {
        "Office".to_string()
    } else {
        name
    }
}

pub fn lobbies_dir(root: &Path) -> PathBuf {
    root.join("lobbies")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{Catalog, TileDef};

    fn catalog() -> Catalog {
        Catalog::from_tiles(vec![TileDef {
            id: 1,
            name: "Wood floor".to_string(),
            kind: "floor".to_string(),
            collision: false,
            blocks_sound: false,
        }])
    }

    #[test]
    fn password_is_required_to_join_and_hidden_from_the_list() {
        let dir = std::env::temp_dir().join(format!("office-lobbies-{}", Uuid::new_v4()));
        let mut hub = Hub::open(catalog(), dir.clone());
        let created = hub.create("Night shift", Some("s3cret".to_string()));
        let listed = hub.list();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].has_password);
        assert_eq!(listed[0].name, "Night shift");
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let denied = hub.hello(&created.id, None, &hello_body(&created.id), tx.clone());
        assert!(denied.is_err());
        let (tx2, _rx2) = tokio::sync::mpsc::unbounded_channel();
        let allowed = hub.hello(&created.id, Some("s3cret"), &hello_body(&created.id), tx2);
        assert!(allowed.is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    fn hello_body(lobby: &str) -> String {
        format!(
            r#"{{"type":"hello","lobby":"{lobby}","name":"Ada","avatar":{{"preset":"ada"}}}}"#
        )
    }
}
