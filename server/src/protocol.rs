use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::world::{AvatarSpec, Office, Snap};

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ClientMsg {
    Hello {
        id: Option<String>,
        name: String,
        avatar: AvatarSpec,
        #[serde(default)]
        host_token: Option<String>,
    },
    Input {
        x: i8,
        y: i8,
    },
    Paint {
        edits: Vec<Edit>,
    },
    Lock {
        x: u32,
        y: u32,
    },
    Chat {
        text: String,
    },
    Avatar {
        avatar: AvatarSpec,
    },
    Signal {
        to: String,
        data: SignalData,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edit {
    pub layer: String,
    pub x: u32,
    pub y: u32,
    pub tile: u16,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalData {
    pub kind: String,
    #[serde(default)]
    pub sdp: Option<String>,
    #[serde(default)]
    pub candidate: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ServerMsg {
    Welcome {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        host_token: Option<String>,
        is_host: bool,
        lobby: String,
        lobby_name: String,
        office: Office,
        players: Vec<Snap>,
    },
    Snapshot {
        players: Vec<Snap>,
    },
    Office {
        office: Office,
    },
    Audible {
        ids: Vec<String>,
    },
    Chat {
        id: String,
        name: String,
        text: String,
    },
    Signal {
        from: String,
        data: SignalData,
    },
    Error {
        message: String,
    },
}

pub fn sanitize_name(raw: &str) -> String {
    let trimmed: String = raw
        .chars()
        .filter(|c| !c.is_control())
        .take(24)
        .collect::<String>()
        .trim()
        .to_string();
    if trimmed.is_empty() {
        "Guest".to_string()
    } else {
        trimmed
    }
}

pub fn valid_player_id(id: &str) -> bool {
    let len = id.len();
    (8..=40).contains(&len)
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
}

pub fn clean_avatar(avatar: AvatarSpec) -> AvatarSpec {
    let preset = avatar.preset.and_then(|p| {
        let p = p.chars().filter(|c| !c.is_control()).take(32).collect::<String>();
        if p.is_empty() { None } else { Some(p) }
    });
    let mut layers = BTreeMap::new();
    for (k, v) in avatar.layers.into_iter().take(8) {
        let key = k.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(24).collect::<String>();
        let val = v.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(32).collect::<String>();
        if !key.is_empty() && !val.is_empty() {
            layers.insert(key, val);
        }
    }
    AvatarSpec { preset, layers }
}
