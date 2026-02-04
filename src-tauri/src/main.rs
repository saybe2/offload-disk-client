use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{RANGE, CONTENT_LENGTH};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

#[derive(Clone, Serialize)]
struct DownloadProgress {
  id: String,
  downloaded: u64,
  total: Option<u64>,
  speed: u64,
  status: String
}

#[derive(Clone, Serialize)]
struct DownloadItem {
  id: String,
  url: String,
  dest_path: String,
  temp_path: String,
  downloaded: u64,
  total: Option<u64>,
  status: String
}

struct DownloadTask {
  item: DownloadItem,
  cancel: Arc<AtomicBool>
}

struct DownloadManager {
  tasks: Mutex<HashMap<String, DownloadTask>>
}

impl DownloadManager {
  fn new() -> Self {
    Self { tasks: Mutex::new(HashMap::new()) }
  }
}

#[derive(Deserialize)]
struct StartDownloadRequest {
  url: String,
  dest_dir: String,
  filename: Option<String>
}

fn resolve_dest_path(dest_dir: &str, filename: &Option<String>, url: &str) -> PathBuf {
  let name = filename.clone().unwrap_or_else(|| {
    url.split('/').last().unwrap_or("download.bin").to_string()
  });
  Path::new(dest_dir).join(name)
}

#[tauri::command]
async fn start_download(app: AppHandle, state: State<'_, DownloadManager>, input: StartDownloadRequest) -> Result<String, String> {
  let id = Uuid::new_v4().to_string();
  let dest_path = resolve_dest_path(&input.dest_dir, &input.filename, &input.url);
  let temp_path = dest_path.with_extension("part");

  let existing = if temp_path.exists() {
    std::fs::metadata(&temp_path).map(|m| m.len()).unwrap_or(0)
  } else {
    0
  };

  let item = DownloadItem {
    id: id.clone(),
    url: input.url.clone(),
    dest_path: dest_path.to_string_lossy().to_string(),
    temp_path: temp_path.to_string_lossy().to_string(),
    downloaded: existing,
    total: None,
    status: "queued".to_string()
  };

  let cancel = Arc::new(AtomicBool::new(false));
  {
    let mut tasks = state.tasks.lock().unwrap();
    tasks.insert(id.clone(), DownloadTask { item: item.clone(), cancel: cancel.clone() });
  }

  tauri::async_runtime::spawn(async move {
    let client = reqwest::Client::new();

    let mut total = None;
    if let Ok(head) = client.head(&input.url).send().await {
      if let Some(len) = head.headers().get(CONTENT_LENGTH) {
        if let Ok(len_str) = len.to_str() {
          if let Ok(len_val) = len_str.parse::<u64>() {
            total = Some(len_val);
          }
        }
      }
    }

    let mut request = client.get(&input.url);
    if existing > 0 {
      request = request.header(RANGE, format!("bytes={}-", existing));
    }

    let response = match request.send().await {
      Ok(resp) => resp,
      Err(err) => {
        emit_progress(&app, &id, existing, total, 0, "error".to_string());
        update_status(&state, &id, "error".to_string());
        eprintln!("download error: {err}");
        return;
      }
    };

    let status = response.status();
    if !status.is_success() && status.as_u16() != 206 {
      emit_progress(&app, &id, existing, total, 0, "error".to_string());
      update_status(&state, &id, "error".to_string());
      return;
    }

    let mut total_bytes = total;
    if let Some(len) = response.content_length() {
      total_bytes = Some(existing + len);
    }

    let mut file = match std::fs::OpenOptions::new().create(true).append(true).open(&temp_path) {
      Ok(f) => f,
      Err(_) => {
        emit_progress(&app, &id, existing, total_bytes, 0, "error".to_string());
        update_status(&state, &id, "error".to_string());
        return;
      }
    };

    update_status(&state, &id, "downloading".to_string());

    let mut downloaded = existing;
    let mut stream = response.bytes_stream();
    let mut last_tick = Instant::now();
    let mut last_bytes = downloaded;

    while let Some(chunk) = stream.next().await {
      if cancel.load(Ordering::SeqCst) {
        update_status(&state, &id, "paused".to_string());
        emit_progress(&app, &id, downloaded, total_bytes, 0, "paused".to_string());
        return;
      }

      let data = match chunk {
        Ok(c) => c,
        Err(_) => {
          update_status(&state, &id, "error".to_string());
          emit_progress(&app, &id, downloaded, total_bytes, 0, "error".to_string());
          return;
        }
      };

      if let Err(_) = std::io::Write::write_all(&mut file, &data) {
        update_status(&state, &id, "error".to_string());
        emit_progress(&app, &id, downloaded, total_bytes, 0, "error".to_string());
        return;
      }

      downloaded += data.len() as u64;

      if last_tick.elapsed() >= Duration::from_millis(500) {
        let delta = downloaded - last_bytes;
        let speed = (delta as f64 / last_tick.elapsed().as_secs_f64()) as u64;
        emit_progress(&app, &id, downloaded, total_bytes, speed, "downloading".to_string());
        last_tick = Instant::now();
        last_bytes = downloaded;
      }
    }

    update_status(&state, &id, "completed".to_string());
    emit_progress(&app, &id, downloaded, total_bytes, 0, "completed".to_string());
    let _ = std::fs::rename(&temp_path, &dest_path);
  });

  Ok(id)
}

#[tauri::command]
fn pause_download(state: State<'_, DownloadManager>, id: String) {
  let tasks = state.tasks.lock().unwrap();
  if let Some(task) = tasks.get(&id) {
    task.cancel.store(true, Ordering::SeqCst);
  }
}

#[tauri::command]
fn list_downloads(state: State<'_, DownloadManager>) -> Vec<DownloadItem> {
  let tasks = state.tasks.lock().unwrap();
  tasks.values().map(|task| task.item.clone()).collect()
}

fn update_status(state: &State<'_, DownloadManager>, id: &str, status: String) {
  let mut tasks = state.tasks.lock().unwrap();
  if let Some(task) = tasks.get_mut(id) {
    task.item.status = status;
  }
}

fn emit_progress(app: &AppHandle, id: &str, downloaded: u64, total: Option<u64>, speed: u64, status: String) {
  let payload = DownloadProgress {
    id: id.to_string(),
    downloaded,
    total,
    speed,
    status
  };
  let _ = app.emit_all("download-progress", payload);
}

fn main() {
  tauri::Builder::default()
    .manage(DownloadManager::new())
    .invoke_handler(tauri::generate_handler![start_download, pause_download, list_downloads])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}