use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;
use uuid::Uuid;

use crate::protocol::{clean_avatar, sanitize_name, valid_player_id, ClientMsg, Edit, ServerMsg, SignalData};

pub const HEARING_RADIUS: f32 = 4.0;
const SPEED: f32 = 4.0;
const BODY: f32 = 0.22;
const MAP_W: u32 = 32;
const MAP_H: u32 = 22;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvatarSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMapEmpty::is_empty")]
    pub layers: std::collections::BTreeMap<String, String>,
}

struct BTreeMapEmpty;
impl BTreeMapEmpty {
    fn is_empty(map: &std::collections::BTreeMap<String, String>) -> bool {
        map.is_empty()
    }
}

impl Default for AvatarSpec {
    fn default() -> Self {
        Self {
            preset: Some("ada".to_string()),
            layers: std::collections::BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Door {
    pub x: u32,
    pub y: u32,
    pub locked: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Office {
    pub version: u64,
    pub width: u32,
    pub height: u32,
    pub floor: Vec<u16>,
    pub wall: Vec<u16>,
    pub object: Vec<u16>,
    pub doors: Vec<Door>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snap {
    pub id: String,
    pub name: String,
    pub avatar: AvatarSpec,
    pub x: f32,
    pub y: f32,
    pub dir: u8,
    pub moving: bool,
}

#[derive(Clone)]
pub struct TileDef {
    pub id: u16,
    pub name: String,
    pub kind: String,
    pub collision: bool,
    pub blocks_sound: bool,
}

#[derive(Clone)]
pub struct Catalog {
    by_id: HashMap<u16, TileDef>,
}

impl Catalog {
    pub fn from_tiles(tiles: Vec<TileDef>) -> Self {
        let by_id = tiles.into_iter().map(|t| (t.id, t)).collect();
        Self { by_id }
    }

    pub fn from_manifest(path: &Path) -> Result<Self, String> {
        let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
        let value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let tiles = value
            .get("tiles")
            .and_then(|v| v.as_array())
            .ok_or("manifest has no tiles")?;
        let mut defs = Vec::new();
        for tile in tiles {
            let id = tile.get("id").and_then(|v| v.as_u64()).ok_or("tile id")? as u16;
            let name = tile
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Tile")
                .to_string();
            let kind = tile
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("floor")
                .to_string();
            let (default_collision, default_sound) = match kind.as_str() {
                "wall" => (true, true),
                "object" => (true, false),
                _ => (false, false),
            };
            let collision = tile
                .get("collision")
                .and_then(|v| v.as_bool())
                .unwrap_or(default_collision);
            let blocks_sound = tile
                .get("blocksSound")
                .and_then(|v| v.as_bool())
                .unwrap_or(default_sound);
            defs.push(TileDef {
                id,
                name,
                kind,
                collision,
                blocks_sound,
            });
        }
        Ok(Self::from_tiles(defs))
    }

    pub fn get(&self, id: u16) -> Option<&TileDef> {
        self.by_id.get(&id)
    }

    pub fn id_named(&self, name: &str) -> Option<u16> {
        self.by_id
            .values()
            .find(|t| t.name == name)
            .map(|t| t.id)
    }
}

pub enum Outbound {
    Text(String),
    Pong(Vec<u8>),
}

struct Player {
    id: String,
    name: String,
    avatar: AvatarSpec,
    x: f32,
    y: f32,
    dir: u8,
    moving: bool,
    input_x: i8,
    input_y: i8,
    token: Option<String>,
    connected: bool,
    generation: u64,
    disconnected_at: Option<Instant>,
    tx: Option<UnboundedSender<Outbound>>,
}

pub struct World {
    pub office: Office,
    pub id: String,
    pub name: String,
    password: Option<String>,
    host_token: Option<String>,
    catalog: Catalog,
    data_path: PathBuf,
    players: HashMap<String, Player>,
    radius: f32,
}

pub struct HelloResult {
    pub id: String,
    pub generation: u64,
    pub welcome: String,
}

impl World {
    pub fn create(
        catalog: Catalog,
        id: String,
        name: String,
        password: Option<String>,
        data_path: PathBuf,
    ) -> Self {
        let office = generate_office(&catalog);
        let world = Self {
            office,
            id,
            name,
            password,
            host_token: Some(Uuid::new_v4().to_string()),
            catalog,
            data_path,
            players: HashMap::new(),
            radius: HEARING_RADIUS,
        };
        world.save();
        world
    }

    pub fn load(catalog: Catalog, data_path: PathBuf) -> Result<Self, String> {
        let loaded = load_office(&data_path)?;
        let id = data_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(&loaded.id)
            .to_string();
        Ok(Self {
            office: loaded.office,
            id,
            name: loaded.name,
            password: loaded.password,
            host_token: loaded.host_token,
            catalog,
            data_path,
            players: HashMap::new(),
            radius: HEARING_RADIUS,
        })
    }

    pub fn host_token(&self) -> Option<&str> {
        self.host_token.as_deref()
    }

    pub fn has_password(&self) -> bool {
        self.password.as_ref().is_some_and(|p| !p.is_empty())
    }

    pub fn password_ok(&self, given: Option<&str>) -> bool {
        match self.password.as_deref().filter(|p| !p.is_empty()) {
            None => true,
            Some(expected) => given == Some(expected),
        }
    }

    pub fn connected_count(&self) -> usize {
        self.players.values().filter(|p| p.connected).count()
    }

    pub fn hello(
        &mut self,
        text: &str,
        tx: UnboundedSender<Outbound>,
    ) -> Result<HelloResult, String> {
        let msg: ClientMsg = serde_json::from_str(text).map_err(|_| "expected hello".to_string())?;
        let ClientMsg::Hello {
            id,
            name,
            avatar,
            host_token,
        } = msg
        else {
            return Err("expected hello".to_string());
        };
        let id = match id {
            Some(id) if valid_player_id(&id) => id,
            _ => Uuid::new_v4().to_string(),
        };
        let name = sanitize_name(&name);
        let avatar = clean_avatar(avatar);
        let is_host = self.claim_host(host_token);
        let token = if is_host { self.host_token.clone() } else { None };
        let existed = self.players.contains_key(&id);
        let generation = if existed {
            let player = self.players.get_mut(&id).expect("player");
            player.name = name;
            player.avatar = avatar;
            player.token = token.clone();
            player.connected = true;
            player.disconnected_at = None;
            player.generation = player.generation.wrapping_add(1);
            player.tx = Some(tx);
            player.generation
        } else {
            let (x, y) = self.spawn_point();
            self.players.insert(
                id.clone(),
                Player {
                    id: id.clone(),
                    name,
                    avatar,
                    x,
                    y,
                    dir: 0,
                    moving: false,
                    input_x: 0,
                    input_y: 0,
                    token: token.clone(),
                    connected: true,
                    generation: 1,
                    disconnected_at: None,
                    tx: Some(tx),
                },
            );
            1
        };
        let welcome = self.welcome_json(&id, token, is_host);
        self.broadcast_snapshot();
        self.broadcast_hearing();
        Ok(HelloResult {
            id,
            generation,
            welcome,
        })
    }

    fn claim_host(&mut self, provided: Option<String>) -> bool {
        if let Some(existing) = &self.host_token {
            return provided.as_ref() == Some(existing);
        }
        let token = Uuid::new_v4().to_string();
        self.host_token = Some(token);
        self.save();
        true
    }

    fn welcome_json(&self, id: &str, token: Option<String>, is_host: bool) -> String {
        let msg = ServerMsg::Welcome {
            id: id.to_string(),
            host_token: if is_host { token } else { None },
            is_host,
            lobby: self.id.clone(),
            lobby_name: self.name.clone(),
            office: self.office.clone(),
            players: self.snaps(),
        };
        serde_json::to_string(&msg).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn generation(&self, id: &str) -> Option<u64> {
        self.players.get(id).map(|p| p.generation)
    }

    pub fn on_message(&mut self, id: &str, text: &str) {
        let Ok(msg) = serde_json::from_str::<ClientMsg>(text) else {
            return;
        };
        match msg {
            ClientMsg::Hello { .. } => {}
            ClientMsg::Input { x, y } => self.set_input(id, x, y),
            ClientMsg::Paint { edits } => self.paint(id, edits),
            ClientMsg::Lock { x, y } => self.toggle_lock(id, x, y),
            ClientMsg::Chat { text } => self.chat(id, &text),
            ClientMsg::Avatar { avatar } => self.set_avatar(id, avatar),
            ClientMsg::Signal { to, data } => self.relay(id, &to, data),
        }
    }

    pub fn detach(&mut self, id: &str, generation: u64) {
        let remove_now = if let Some(player) = self.players.get_mut(id) {
            if player.generation != generation {
                return;
            }
            player.connected = false;
            player.moving = false;
            player.input_x = 0;
            player.input_y = 0;
            player.tx = None;
            player.disconnected_at = Some(Instant::now());
            false
        } else {
            true
        };
        if remove_now {
            return;
        }
        self.broadcast_snapshot();
        self.broadcast_hearing();
    }

    pub fn tick(&mut self, dt: f32) {
        let ids: Vec<String> = self.players.keys().cloned().collect();
        for id in ids {
            self.step(&id, dt);
        }
    }

    pub fn broadcast_snapshot(&self) {
        let msg = ServerMsg::Snapshot {
            players: self.snaps(),
        };
        self.broadcast(&msg);
    }

    pub fn broadcast_hearing(&self) {
        let map = self.hearing_map();
        for (id, ids) in map {
            self.send(
                &id,
                &ServerMsg::Audible { ids },
            );
        }
    }

    pub fn sweep(&mut self) {
        let stale: Vec<String> = self
            .players
            .iter()
            .filter(|(_, p)| {
                p.disconnected_at
                    .map(|t| t.elapsed().as_secs() > 20)
                    .unwrap_or(false)
            })
            .map(|(id, _)| id.clone())
            .collect();
        if stale.is_empty() {
            return;
        }
        for id in stale {
            self.players.remove(&id);
        }
        self.broadcast_snapshot();
        self.broadcast_hearing();
    }

    fn set_input(&mut self, id: &str, x: i8, y: i8) {
        if let Some(player) = self.players.get_mut(id) {
            player.input_x = x.clamp(-1, 1);
            player.input_y = y.clamp(-1, 1);
        }
    }

    fn set_avatar(&mut self, id: &str, avatar: AvatarSpec) {
        if let Some(player) = self.players.get_mut(id) {
            player.avatar = clean_avatar(avatar);
        }
    }

    fn step(&mut self, id: &str, dt: f32) {
        let (ix, iy, x, y) = {
            let Some(player) = self.players.get(id) else {
                return;
            };
            if !player.connected {
                return;
            }
            (player.input_x, player.input_y, player.x, player.y)
        };
        let len = ((ix as f32) * (ix as f32) + (iy as f32) * (iy as f32)).sqrt();
        if len == 0.0 {
            if let Some(player) = self.players.get_mut(id) {
                player.moving = false;
            }
            return;
        }
        let dx = (ix as f32) / len * SPEED * dt;
        let dy = (iy as f32) / len * SPEED * dt;
        let nx = x + dx;
        let ny = y + dy;
        let (fx, fy) = if !self.solid_at(nx, ny) {
            (nx, ny)
        } else if !self.solid_at(nx, y) {
            (nx, y)
        } else if !self.solid_at(x, ny) {
            (x, ny)
        } else {
            (x, y)
        };
        let Some(player) = self.players.get_mut(id) else {
            return;
        };
        player.x = fx;
        player.y = fy;
        player.moving = (fx - x).abs() > 0.0001 || (fy - y).abs() > 0.0001;
        player.dir = if ix.abs() > iy.abs() {
            if ix < 0 { 1 } else { 2 }
        } else if iy < 0 {
            3
        } else if iy > 0 {
            0
        } else {
            player.dir
        };
    }

    fn paint(&mut self, id: &str, edits: Vec<Edit>) {
        if !self.is_host(id) {
            self.send(
                id,
                &ServerMsg::Error {
                    message: "only the host can change the office".to_string(),
                },
            );
            return;
        }
        let mut changed = false;
        for edit in edits.into_iter().take(64) {
            if self.apply_edit(edit) {
                changed = true;
            }
        }
        if !changed {
            return;
        }
        self.sync_doors();
        self.office.version = self.office.version.wrapping_add(1);
        self.save();
        self.broadcast_office();
        self.broadcast_hearing();
    }

    fn apply_edit(&mut self, edit: Edit) -> bool {
        if !self.in_bounds(edit.x, edit.y) {
            return false;
        }
        let index = self.index(edit.x, edit.y);
        if edit.tile != 0 {
            let Some(def) = self.catalog.get(edit.tile) else {
                return false;
            };
            let ok = match edit.layer.as_str() {
                "floor" => def.kind == "floor",
                "wall" => def.kind == "wall" || def.kind == "door",
                "object" => def.kind == "object",
                _ => false,
            };
            if !ok {
                return false;
            }
        } else if !matches!(edit.layer.as_str(), "floor" | "wall" | "object") {
            return false;
        }
        let cell = match edit.layer.as_str() {
            "floor" => &mut self.office.floor,
            "wall" => &mut self.office.wall,
            "object" => &mut self.office.object,
            _ => return false,
        };
        if cell[index] == edit.tile {
            return false;
        }
        cell[index] = edit.tile;
        true
    }

    fn toggle_lock(&mut self, id: &str, x: u32, y: u32) {
        if !self.is_host(id) {
            return;
        }
        let Some(door) = self
            .office
            .doors
            .iter_mut()
            .find(|d| d.x == x && d.y == y)
        else {
            return;
        };
        door.locked = !door.locked;
        let locked = door.locked;
        self.office.version = self.office.version.wrapping_add(1);
        if locked {
            self.nudge_off(x, y);
        }
        self.save();
        self.broadcast_office();
        self.broadcast_hearing();
        self.broadcast_snapshot();
    }

    fn nudge_off(&mut self, x: u32, y: u32) {
        let ids: Vec<String> = self.players.keys().cloned().collect();
        for id in ids {
            let (px, py) = {
                let Some(p) = self.players.get(&id) else { continue };
                (p.x, p.y)
            };
            if px.floor() as u32 != x || py.floor() as u32 != y {
                continue;
            }
            let mut found = None;
            for (dx, dy) in [(0.0, 1.0), (0.0, -1.0), (1.0, 0.0), (-1.0, 0.0), (1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)] {
                let nx = px + dx;
                let ny = py + dy;
                if !self.solid_at(nx, ny) {
                    found = Some((nx, ny));
                    break;
                }
            }
            if let Some((nx, ny)) = found {
                if let Some(p) = self.players.get_mut(&id) {
                    p.x = nx;
                    p.y = ny;
                }
            }
        }
    }

    fn chat(&self, id: &str, text: &str) {
        let text: String = text.chars().filter(|c| !c.is_control() || *c == '\n').take(400).collect();
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        let Some(sender) = self.players.get(id) else { return };
        if !sender.connected {
            return;
        }
        let msg = ServerMsg::Chat {
            id: id.to_string(),
            name: sender.name.clone(),
            text,
        };
        self.send(id, &msg);
        let labels = self.sound_labels();
        for other in self.players.values() {
            if other.id == id || !other.connected {
                continue;
            }
            if self.can_hear(&sender.id, &other.id, &labels) {
                self.send(&other.id, &msg);
            }
        }
    }

    fn relay(&self, id: &str, to: &str, data: SignalData) {
        if id == to || !self.players.contains_key(to) {
            return;
        }
        if data.kind != "offer" && data.kind != "answer" && data.kind != "ice" {
            return;
        }
        if let Some(sdp) = &data.sdp {
            if sdp.len() > 20000 {
                return;
            }
        }
        self.send(
            to,
            &ServerMsg::Signal {
                from: id.to_string(),
                data,
            },
        );
    }

    fn is_host(&self, id: &str) -> bool {
        match (
            &self.host_token,
            self.players.get(id).and_then(|p| p.token.as_ref()),
        ) {
            (Some(expected), Some(got)) => expected == got,
            _ => false,
        }
    }

    fn snaps(&self) -> Vec<Snap> {
        let mut snaps: Vec<Snap> = self
            .players
            .values()
            .filter(|p| p.connected)
            .map(|p| Snap {
                id: p.id.clone(),
                name: p.name.clone(),
                avatar: p.avatar.clone(),
                x: p.x,
                y: p.y,
                dir: p.dir,
                moving: p.moving,
            })
            .collect();
        snaps.sort_by(|a, b| a.id.cmp(&b.id));
        snaps
    }

    fn hearing_map(&self) -> HashMap<String, Vec<String>> {
        let labels = self.sound_labels();
        let ids: Vec<&Player> = self.players.values().filter(|p| p.connected).collect();
        let mut out = HashMap::new();
        for player in &ids {
            let mut audible = Vec::new();
            for other in &ids {
                if player.id != other.id && self.can_hear(&player.id, &other.id, &labels) {
                    audible.push(other.id.clone());
                }
            }
            audible.sort();
            out.insert(player.id.clone(), audible);
        }
        out
    }

    fn can_hear(&self, a: &str, b: &str, labels: &[i32]) -> bool {
        let (Some(pa), Some(pb)) = (self.players.get(a), self.players.get(b)) else {
            return false;
        };
        let la = self.label_at(labels, pa.x, pa.y);
        let lb = self.label_at(labels, pb.x, pb.y);
        if la < 0 || la != lb {
            return false;
        }
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        dx * dx + dy * dy <= self.radius * self.radius
    }

    fn label_at(&self, labels: &[i32], x: f32, y: f32) -> i32 {
        let cx = x.floor() as i32;
        let cy = y.floor() as i32;
        if cx < 0 || cy < 0 || cx >= self.office.width as i32 || cy >= self.office.height as i32 {
            return -1;
        }
        labels[self.index(cx as u32, cy as u32)]
    }

    fn sound_labels(&self) -> Vec<i32> {
        let w = self.office.width;
        let h = self.office.height;
        let mut labels = vec![-1; (w * h) as usize];
        let mut next = 0;
        for y in 0..h {
            for x in 0..w {
                let index = self.index(x, y);
                if labels[index] != -1 || !self.sound_open(x as i32, y as i32) {
                    continue;
                }
                let mut queue = VecDeque::new();
                queue.push_back((x, y));
                labels[index] = next;
                while let Some((cx, cy)) = queue.pop_front() {
                    for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                        let nx = cx as i32 + dx;
                        let ny = cy as i32 + dy;
                        if !self.sound_open(nx, ny) {
                            continue;
                        }
                        let ni = self.index(nx as u32, ny as u32);
                        if labels[ni] != -1 {
                            continue;
                        }
                        labels[ni] = next;
                        queue.push_back((nx as u32, ny as u32));
                    }
                }
                next += 1;
            }
        }
        labels
    }

    fn sound_open(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x >= self.office.width as i32 || y >= self.office.height as i32 {
            return false;
        }
        let tile = self.office.wall[self.index(x as u32, y as u32)];
        if tile == 0 {
            return true;
        }
        let Some(def) = self.catalog.get(tile) else {
            return true;
        };
        if def.kind == "door" {
            return !self.door_locked(x as u32, y as u32);
        }
        !def.blocks_sound
    }

    fn door_locked(&self, x: u32, y: u32) -> bool {
        self.office
            .doors
            .iter()
            .any(|d| d.x == x && d.y == y && d.locked)
    }

    fn solid_at(&self, x: f32, y: f32) -> bool {
        for (dx, dy) in [(-BODY, -BODY), (BODY, -BODY), (-BODY, BODY), (BODY, BODY)] {
            let cx = (x + dx).floor() as i32;
            let cy = (y + dy).floor() as i32;
            if self.cell_solid(cx, cy) {
                return true;
            }
        }
        false
    }

    fn cell_solid(&self, x: i32, y: i32) -> bool {
        if x < 0 || y < 0 || x >= self.office.width as i32 || y >= self.office.height as i32 {
            return true;
        }
        let index = self.index(x as u32, y as u32);
        let wall = self.office.wall[index];
        if wall != 0 {
            if let Some(def) = self.catalog.get(wall) {
                if def.kind == "door" {
                    if self.door_locked(x as u32, y as u32) {
                        return true;
                    }
                } else if def.collision {
                    return true;
                }
            }
        }
        let object = self.office.object[index];
        if object != 0 {
            if let Some(def) = self.catalog.get(object) {
                if def.collision {
                    return true;
                }
            }
        }
        false
    }

    fn sync_doors(&mut self) {
        let mut old = HashMap::new();
        for door in &self.office.doors {
            old.insert((door.x, door.y), door.locked);
        }
        let mut doors = Vec::new();
        for y in 0..self.office.height {
            for x in 0..self.office.width {
                let tile = self.office.wall[self.index(x, y)];
                let is_door = self.catalog.get(tile).map(|t| t.kind == "door").unwrap_or(false);
                if is_door {
                    doors.push(Door {
                        x,
                        y,
                        locked: old.get(&(x, y)).copied().unwrap_or(false),
                    });
                }
            }
        }
        self.office.doors = doors;
    }

    fn spawn_point(&self) -> (f32, f32) {
        let preferred = [(4.5, 6.5), (6.5, 8.5), (8.5, 6.5), (5.5, 10.5), (11.5, 8.5), (3.5, 4.5)];
        for (x, y) in preferred {
            if !self.solid_at(x, y) && !self.crowded(x, y) {
                return (x, y);
            }
        }
        for y in 1..self.office.height.saturating_sub(1) {
            for x in 1..self.office.width.saturating_sub(1) {
                let px = x as f32 + 0.5;
                let py = y as f32 + 0.5;
                if !self.solid_at(px, py) && !self.crowded(px, py) {
                    return (px, py);
                }
            }
        }
        (2.5, 2.5)
    }

    fn crowded(&self, x: f32, y: f32) -> bool {
        self.players.values().any(|p| {
            let dx = p.x - x;
            let dy = p.y - y;
            dx * dx + dy * dy < 0.81
        })
    }

    fn in_bounds(&self, x: u32, y: u32) -> bool {
        x < self.office.width && y < self.office.height
    }

    fn index(&self, x: u32, y: u32) -> usize {
        (y * self.office.width + x) as usize
    }

    fn broadcast_office(&self) {
        self.broadcast(&ServerMsg::Office {
            office: self.office.clone(),
        });
    }

    fn broadcast(&self, msg: &ServerMsg) {
        let text = serde_json::to_string(msg).unwrap_or_else(|_| "{}".to_string());
        for player in self.players.values() {
            if player.connected {
                if let Some(tx) = &player.tx {
                    let _ = tx.send(Outbound::Text(text.clone()));
                }
            }
        }
    }

    fn send(&self, id: &str, msg: &ServerMsg) {
        let Some(player) = self.players.get(id) else { return };
        let Some(tx) = &player.tx else { return };
        if let Ok(text) = serde_json::to_string(msg) {
            let _ = tx.send(Outbound::Text(text));
        }
    }

    fn save(&self) {
        if self.data_path.as_os_str().is_empty() {
            return;
        }
        if let Some(parent) = self.data_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut value = serde_json::to_value(&self.office).unwrap_or(Value::Null);
        if let Some(obj) = value.as_object_mut() {
            obj.insert("id".to_string(), Value::String(self.id.clone()));
            obj.insert("name".to_string(), Value::String(self.name.clone()));
            if let Some(token) = &self.host_token {
                obj.insert("hostToken".to_string(), Value::String(token.clone()));
            }
            if let Some(password) = &self.password {
                obj.insert("password".to_string(), Value::String(password.clone()));
            }
        }
        if let Ok(text) = serde_json::to_string_pretty(&value) {
            let _ = fs::write(&self.data_path, text);
        }
    }
}

struct LoadedOffice {
    office: Office,
    host_token: Option<String>,
    name: String,
    password: Option<String>,
    id: String,
}

fn load_office(path: &Path) -> Result<LoadedOffice, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut value: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let take = |value: &mut Value, key: &str| -> Option<String> {
        value
            .as_object_mut()?
            .remove(key)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .filter(|s| !s.is_empty())
    };
    let token = take(&mut value, "hostToken");
    let name = take(&mut value, "name").unwrap_or_else(|| "Office".to_string());
    let password = take(&mut value, "password");
    let id = take(&mut value, "id").unwrap_or_else(|| "lobby".to_string());
    let office: Office = serde_json::from_value(value).map_err(|e| e.to_string())?;
    Ok(LoadedOffice {
        office,
        host_token: token,
        name,
        password,
        id,
    })
}

fn generate_office(catalog: &Catalog) -> Office {
    let wood = catalog.id_named("Wood floor").unwrap_or(1);
    let carpet = catalog.id_named("Carpet").unwrap_or(2);
    let wall = catalog.id_named("Wall").unwrap_or(3);
    let door = catalog.id_named("Door").unwrap_or(4);
    let chair = catalog.id_named("Chair").unwrap_or(5);
    let armchair = catalog.id_named("Armchair").unwrap_or(6);
    let width = MAP_W;
    let height = MAP_H;
    let n = (width * height) as usize;
    let mut floor = vec![wood; n];
    let mut walls = vec![0u16; n];
    let mut object = vec![0u16; n];
    let idx = |x: u32, y: u32| (y * width + x) as usize;
    for x in 0..width {
        walls[idx(x, 0)] = wall;
        walls[idx(x, height - 1)] = wall;
    }
    for y in 0..height {
        walls[idx(0, y)] = wall;
        walls[idx(width - 1, y)] = wall;
    }
    for x in 20..=30 {
        walls[idx(x, 3)] = wall;
        walls[idx(x, 12)] = wall;
    }
    for y in 3..=12 {
        walls[idx(20, y)] = wall;
        walls[idx(30, y)] = wall;
    }
    walls[idx(20, 7)] = door;
    for y in 4..12 {
        for x in 21..30 {
            floor[idx(x, y)] = carpet;
        }
    }
    for (x, y, tile) in [(23, 6, chair), (26, 6, chair), (23, 9, armchair), (26, 9, armchair)] {
        object[idx(x, y)] = tile;
    }
    Office {
        version: 1,
        width,
        height,
        floor,
        wall: walls,
        object,
        doors: vec![Door { x: 20, y: 7, locked: false }],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tile(id: u16, name: &str, kind: &str, collision: bool, blocks_sound: bool) -> TileDef {
        TileDef {
            id,
            name: name.to_string(),
            kind: kind.to_string(),
            collision,
            blocks_sound,
        }
    }

    fn catalog() -> Catalog {
        Catalog::from_tiles(vec![
            tile(1, "Wood floor", "floor", false, false),
            tile(3, "Wall", "wall", true, true),
            tile(4, "Door", "door", false, false),
            tile(5, "Chair", "object", true, false),
        ])
    }

    fn blank(catalog: Catalog, w: u32, h: u32) -> World {
        let n = (w * h) as usize;
        World {
            office: Office {
                version: 1,
                width: w,
                height: h,
                floor: vec![1; n],
                wall: vec![0; n],
                object: vec![0; n],
                doors: vec![],
            },
            id: String::new(),
            name: String::new(),
            password: None,
            host_token: None,
            catalog,
            data_path: PathBuf::new(),
            players: HashMap::new(),
            radius: HEARING_RADIUS,
        }
    }

    fn add_player(world: &mut World, id: &str, x: f32, y: f32) {
        world.players.insert(
            id.to_string(),
            Player {
                id: id.to_string(),
                name: id.to_string(),
                avatar: AvatarSpec::default(),
                x,
                y,
                dir: 0,
                moving: false,
                input_x: 0,
                input_y: 0,
                token: None,
                connected: true,
                generation: 1,
                disconnected_at: None,
                tx: None,
            },
        );
    }

    #[test]
    fn manifest_has_door() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../assets/kenney/manifest.json");
        let catalog = Catalog::from_manifest(&path).unwrap();
        assert_eq!(catalog.id_named("Door"), Some(4));
        assert!(catalog.get(3).unwrap().blocks_sound);
        assert!(!catalog.get(5).unwrap().blocks_sound);
    }

    #[test]
    fn wall_and_distance_gate_hearing() {
        let mut world = blank(catalog(), 10, 5);
        for y in 0..5 {
            world.office.wall[y * 10 + 3] = 3;
        }
        add_player(&mut world, "a", 1.5, 2.5);
        add_player(&mut world, "b", 4.5, 2.5);
        let labels = world.sound_labels();
        assert!(!world.can_hear("a", "b", &labels));

        for y in 0..5 {
            world.office.wall[y * 10 + 3] = 0;
        }
        let labels = world.sound_labels();
        assert!(world.can_hear("a", "b", &labels));
        add_player(&mut world, "c", 1.5, 2.5);
        world.players.get_mut("c").unwrap().x = 9.5;
        let labels = world.sound_labels();
        assert!(!world.can_hear("a", "c", &labels));
    }

    #[test]
    fn furniture_does_not_block_sound() {
        let mut world = blank(catalog(), 6, 3);
        world.office.object[1 * 6 + 1] = 5;
        add_player(&mut world, "a", 0.5, 1.5);
        add_player(&mut world, "b", 2.5, 1.5);
        let labels = world.sound_labels();
        assert!(world.can_hear("a", "b", &labels));
    }

    #[test]
    fn locked_door_isolates_and_blocks_movement() {
        let mut world = blank(catalog(), 8, 5);
        for x in 0..8 {
            world.office.wall[x] = 3;
            world.office.wall[4 * 8 + x] = 3;
        }
        for y in 0..5 {
            world.office.wall[y * 8] = 3;
            world.office.wall[y * 8 + 7] = 3;
            world.office.wall[y * 8 + 3] = 3;
        }
        world.office.wall[2 * 8 + 3] = 4;
        world.office.doors.push(Door { x: 3, y: 2, locked: true });
        add_player(&mut world, "inside", 2.2, 2.5);
        add_player(&mut world, "outside", 4.5, 2.5);
        let labels = world.sound_labels();
        assert!(!world.can_hear("inside", "outside", &labels));

        world.players.get_mut("inside").unwrap().input_x = 1;
        let before = world.players.get("inside").unwrap().x;
        world.tick(0.5);
        let after = world.players.get("inside").unwrap().x;
        assert!((after - before).abs() < 0.05);

        world.office.doors[0].locked = false;
        world.tick(0.2);
        let moved = world.players.get("inside").unwrap().x;
        assert!(moved > after + 0.2);
        let labels = world.sound_labels();
        assert!(world.can_hear("inside", "outside", &labels));
    }

    #[test]
    fn generated_office_has_a_door() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../assets/kenney/manifest.json");
        let catalog = Catalog::from_manifest(&path).unwrap();
        let office = generate_office(&catalog);
        assert_eq!(office.doors.len(), 1);
        assert!(!office.doors[0].locked);
        assert_eq!(office.wall[(7 * office.width + 20) as usize], 4);
    }
}
