use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as base64_engine;
use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;
use aes::Aes256;
use ctr::Ctr128BE;
use ghash::{GHash, Block as GHashBlock, Key as GHashKey, universal_hash::UniversalHash};
use aes::cipher::{KeyInit, KeyIvInit, BlockEncrypt, StreamCipher};

const DIRECT_RETRY_INTERVAL: Duration = Duration::from_secs(300);

#[derive(Clone, Serialize)]
struct DownloadProgress {
  id: String,
  downloaded: u64,
  total: Option<u64>,
  speed: u64,
  status: String,
  name: String
}

#[derive(Clone, Serialize)]
struct DownloadItem {
  id: String,
  archive_id: String,
  name: String,
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

struct ApiState {
  base_url: Mutex<String>,
  client: Mutex<Option<reqwest::Client>>,
  master_key: Mutex<Option<String>>
}

impl ApiState {
  fn new() -> Self {
    Self {
      base_url: Mutex::new(String::new()),
      client: Mutex::new(None),
      master_key: Mutex::new(None)
    }
  }
}

#[derive(Deserialize)]
struct LoginRequest {
  server_url: String,
  username: String,
  password: String
}

#[derive(Deserialize)]
struct PartsResponse {
  archiveId: String,
  isBundle: bool,
  chunkSizeBytes: Option<u64>,
  iv: String,
  authTag: String,
  originalSize: Option<u64>,
  encryptedSize: Option<u64>,
  downloadName: Option<String>,
  displayName: Option<String>,
  files: Option<Vec<ArchiveFile>>,
  parts: Vec<PartInfo>
}

#[derive(Deserialize, Clone)]
struct ArchiveFile {
  originalName: Option<String>,
  size: Option<u64>
}

#[derive(Deserialize, Clone)]
struct PartInfo {
  index: u64,
  size: u64,
  hash: String,
  url: String
}

fn sanitize_filename(name: &str) -> String {
  let invalid = ["<", ">", ":", "\"", "/", "\\", "|", "?", "*"];
  let mut safe = name.to_string();
  for item in &invalid {
    safe = safe.replace(item, "_");
  }
  safe = safe.trim_end_matches(|c| c == '.' || c == ' ').to_string();
  if safe.is_empty() {
    safe = "_".to_string();
  }
  let upper = safe.to_uppercase();
  let reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"];
  if reserved.iter().any(|r| upper == *r || upper.starts_with(&format!("{}.", r))) {
    safe = format!("_{}", safe);
  }
  if safe.len() > 255 {
    safe.truncate(255);
  }
  safe
}

fn derive_key(master_key: &str) -> Vec<u8> {
  let mut hasher = Sha256::new();
  hasher.update(master_key.as_bytes());
  hasher.finalize().to_vec()
}

async fn api_client(state: &State<'_, ApiState>) -> Result<(reqwest::Client, String), String> {
  let base_url = state.base_url.lock().unwrap().clone();
  let client_guard = state.client.lock().unwrap();
  let client = client_guard.clone().ok_or_else(|| "not_logged_in".to_string())?;
  if base_url.is_empty() {
    return Err("missing_server_url".to_string());
  }
  Ok((client, base_url))
}

async fn api_get(state: &State<'_, ApiState>, path: &str) -> Result<reqwest::Response, String> {
  let (client, base_url) = api_client(state).await?;
  let url = format!("{}{}", base_url, path);
  client.get(url).send().await.map_err(|e| e.to_string())
}

async fn api_post(state: &State<'_, ApiState>, path: &str) -> Result<reqwest::Response, String> {
  let (client, base_url) = api_client(state).await?;
  let url = format!("{}{}", base_url, path);
  client.post(url).send().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn login(state: State<'_, ApiState>, input: LoginRequest) -> Result<String, String> {
  let base_url = input.server_url.trim_end_matches('/').to_string();
  let client = reqwest::Client::builder()
    .cookie_store(true)
    .build()
    .map_err(|e| e.to_string())?;

  let url = format!("{}/api/auth/login", base_url);
  let res = client
    .post(url)
    .json(&serde_json::json!({ "username": input.username, "password": input.password }))
    .send()
    .await
    .map_err(|e| e.to_string())?;

  if !res.status().is_success() {
    return Err("invalid_credentials".to_string());
  }

  *state.base_url.lock().unwrap() = base_url;
  *state.client.lock().unwrap() = Some(client);

  let key_res = api_get(&state, "/api/auth/master-key").await?;
  if !key_res.status().is_success() {
    return Err(format!("master_key_unavailable:{}", key_res.status().as_u16()));
  }
  let key_json = key_res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
  let master_key = key_json.get("masterKey").and_then(|v| v.as_str()).ok_or("missing_master_key")?.to_string();
  *state.master_key.lock().unwrap() = Some(master_key.clone());
  Ok(master_key)
}

#[tauri::command]
async fn list_folders(state: State<'_, ApiState>) -> Result<serde_json::Value, String> {
  let res = api_get(&state, "/api/folders").await?;
  let json = res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
  Ok(json)
}

#[tauri::command]
async fn list_archives(state: State<'_, ApiState>, folder_id: Option<String>) -> Result<serde_json::Value, String> {
  let query = if let Some(folder) = folder_id.filter(|value| !value.is_empty() && value != "null") {
    format!("/api/archives?folderId={}", folder)
  } else {
    "/api/archives?root=1".to_string()
  };
  let res = api_get(&state, &query).await?;
  let json = res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
  Ok(json)
}

#[tauri::command]
async fn start_archive_download(
  app: AppHandle,
  state: State<'_, ApiState>,
  downloads: State<'_, DownloadManager>,
  archive_id: String,
  download_dir: String,
  file_index: Option<u32>
) -> Result<String, String> {
  let id = Uuid::new_v4().to_string();
  let task_id = id.clone();
  let master_key = state.master_key.lock().unwrap().clone().ok_or("missing_master_key")?;

  let parts_path = format!("/api/archives/{}/parts", archive_id);
  let res = api_get(&state, &parts_path).await?;
  if !res.status().is_success() {
    return Err(format!("server_error:{}", res.status().as_u16()));
  }
  let parts = res.json::<PartsResponse>().await.map_err(|e| e.to_string())?;

  let download_name = if let Some(index) = file_index {
    parts.files.as_ref()
      .and_then(|files| files.get(index as usize))
      .and_then(|f| f.originalName.clone())
      .or(parts.downloadName.clone())
      .or(parts.displayName.clone())
      .unwrap_or_else(|| "download.bin".to_string())
  } else {
    parts.downloadName.clone().or(parts.displayName.clone()).unwrap_or_else(|| "download.bin".to_string())
  };
  let safe_name = sanitize_filename(&download_name);
  let dest_path = Path::new(&download_dir).join(&safe_name);

  let temp_root = tauri::api::path::app_cache_dir(&app.config()).ok_or("missing_cache_dir")?;
  let temp_dir = temp_root.join("offload_parts").join(&archive_id);
  std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;

  let item = DownloadItem {
    id: id.clone(),
    archive_id: archive_id.clone(),
    name: safe_name.clone(),
    downloaded: 0,
    total: parts.originalSize.or(parts.encryptedSize),
    status: "queued".to_string()
  };

  let cancel = Arc::new(AtomicBool::new(false));
  {
    let mut tasks = downloads.tasks.lock().unwrap();
    tasks.insert(id.clone(), DownloadTask { item: item.clone(), cancel: cancel.clone() });
  }

  let app_handle = app.clone();
  tauri::async_runtime::spawn(async move {
    let api_state = app_handle.state::<ApiState>();
    let downloads_state = app_handle.state::<DownloadManager>();
    log_event(&app_handle, "info", &format!("download start archive={} name={}", archive_id, safe_name));
    let total = parts.originalSize.or(parts.encryptedSize);
    let mut downloaded: u64 = 0;
    let mut last_tick = Instant::now();
    let mut last_bytes = 0;

    let mut discord_ok = true;
    let mut next_direct_check = Instant::now();

    let mut parts_sorted = parts.parts.clone();
    parts_sorted.sort_by_key(|p| p.index);

    for part in parts_sorted.iter() {
      if cancel.load(Ordering::SeqCst) {
        emit_progress(&app_handle, &task_id, downloaded, total, 0, "paused".to_string(), safe_name.clone());
        update_status(&downloads_state, &task_id, "paused".to_string());
        return;
      }

      let part_path = temp_dir.join(format!("part_{}", part.index));
      if let Ok(existing) = verify_part_hash(&part_path, &part.hash).await {
        if existing {
          downloaded += part.size;
          continue;
        }
      }

      let should_try_direct = discord_ok || Instant::now() >= next_direct_check;
      let mut direct_ok = false;

      if should_try_direct {
        let mut url = part.url.clone();
        match download_part_direct(&url, &part_path, cancel.clone()).await {
          Ok(_) => {
            direct_ok = true;
            if !discord_ok {
              discord_ok = true;
            }
          }
          Err(err) => {
            if err == "expired" {
              if let Ok(new_url) = refresh_part_url(&api_state, &archive_id, part.index).await {
                url = new_url;
                if download_part_direct(&url, &part_path, cancel.clone()).await.is_ok() {
                  direct_ok = true;
                  discord_ok = true;
                }
              }
            }

            if !direct_ok {
              discord_ok = false;
              next_direct_check = Instant::now() + DIRECT_RETRY_INTERVAL;
            }
          }
        }
      }

      if !direct_ok {
        let relay_path = format!("/api/archives/{}/parts/{}/relay", archive_id, part.index);
        log_event(&app_handle, "info", &format!("relay part {} via server", part.index));
        if download_part_relay(&api_state, &relay_path, &part_path, cancel.clone()).await.is_err() {
          emit_progress(&app_handle, &task_id, downloaded, total, 0, "error".to_string(), safe_name.clone());
          update_status(&downloads_state, &task_id, "error".to_string());
          log_event(&app_handle, "error", &format!("download failed archive={}", archive_id));
          return;
        }
      }

      if let Ok(valid) = verify_part_hash(&part_path, &part.hash).await {
        if !valid {
          emit_progress(&app_handle, &task_id, downloaded, total, 0, "error".to_string(), safe_name.clone());
          update_status(&downloads_state, &task_id, "error".to_string());
          return;
        }
      }

      downloaded += part.size;
      if last_tick.elapsed() >= Duration::from_millis(500) {
        let delta = downloaded - last_bytes;
        let speed = (delta as f64 / last_tick.elapsed().as_secs_f64()) as u64;
        emit_progress(&app_handle, &task_id, downloaded, total, speed, "downloading".to_string(), safe_name.clone());
        last_tick = Instant::now();
        last_bytes = downloaded;
      }
    }

    if let Err(_) = decrypt_parts(&parts, &temp_dir, &dest_path, &master_key, file_index.map(|v| v as usize)) {
      emit_progress(&app_handle, &task_id, downloaded, total, 0, "error".to_string(), safe_name.clone());
      update_status(&downloads_state, &task_id, "error".to_string());
      log_event(&app_handle, "error", &format!("decrypt failed archive={}", archive_id));
      return;
    }

    let _ = std::fs::remove_dir_all(&temp_dir);
    emit_progress(&app_handle, &task_id, downloaded, total, 0, "completed".to_string(), safe_name.clone());
    update_status(&downloads_state, &task_id, "completed".to_string());
    log_event(&app_handle, "info", &format!("download completed archive={}", archive_id));
  });

  Ok(id)
}

async fn verify_part_hash(path: &Path, expected: &str) -> Result<bool, String> {
  if !path.exists() {
    return Ok(false);
  }
  let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
  let mut hasher = Sha256::new();
  hasher.update(&bytes);
  let result = format!("{:x}", hasher.finalize());
  Ok(result == expected)
}

async fn download_part_direct(url: &str, dest: &Path, cancel: Arc<AtomicBool>) -> Result<(), String> {
  let client = reqwest::Client::new();
  let response = client.get(url).send().await.map_err(|e| e.to_string())?;
  if response.status().as_u16() == 404 {
    return Err("expired".to_string());
  }
  if !response.status().is_success() {
    return Err(format!("status_{}", response.status().as_u16()));
  }

  let mut file = OpenOptions::new().create(true).write(true).truncate(true).open(dest).map_err(|e| e.to_string())?;
  let mut stream = response.bytes_stream();
  while let Some(chunk) = stream.next().await {
    if cancel.load(Ordering::SeqCst) {
      return Err("cancelled".to_string());
    }
    let data = chunk.map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
  }
  Ok(())
}

async fn download_part_relay(state: &State<'_, ApiState>, path: &str, dest: &Path, cancel: Arc<AtomicBool>) -> Result<(), String> {
  let res = api_get(state, path).await?;
  if !res.status().is_success() {
    return Err(format!("relay_status_{}", res.status().as_u16()));
  }

  let mut file = OpenOptions::new().create(true).write(true).truncate(true).open(dest).map_err(|e| e.to_string())?;
  let mut stream = res.bytes_stream();
  while let Some(chunk) = stream.next().await {
    if cancel.load(Ordering::SeqCst) {
      return Err("cancelled".to_string());
    }
    let data = chunk.map_err(|e| e.to_string())?;
    file.write_all(&data).map_err(|e| e.to_string())?;
  }
  Ok(())
}

async fn refresh_part_url(state: &State<'_, ApiState>, archive_id: &str, index: u64) -> Result<String, String> {
  let path = format!("/api/archives/{}/parts/{}/refresh", archive_id, index);
  let res = api_post(state, &path).await?;
  if !res.status().is_success() {
    return Err(format!("refresh_status_{}", res.status().as_u16()));
  }
  let json = res.json::<serde_json::Value>().await.map_err(|e| e.to_string())?;
  let url = json.get("url").and_then(|v| v.as_str()).ok_or("missing_url")?;
  Ok(url.to_string())
}

fn decrypt_parts(parts: &PartsResponse, temp_dir: &Path, output_path: &Path, master_key: &str, file_index: Option<usize>) -> Result<(), String> {
  let key = derive_key(master_key);
  let iv = base64_engine.decode(parts.iv.as_bytes()).map_err(|e| e.to_string())?;
  let auth_tag = base64_engine.decode(parts.authTag.as_bytes()).map_err(|e| e.to_string())?;

  if iv.len() != 12 {
    return Err("invalid_iv".to_string());
  }
  if auth_tag.len() != 16 {
    return Err("invalid_auth_tag".to_string());
  }

  let mut sorted = parts.parts.clone();
  sorted.sort_by_key(|p| p.index);

  let tmp_out = output_path.with_extension("download");
  let decrypt_target = if file_index.is_some() { tmp_out.with_extension("zip") } else { tmp_out.clone() };
  let mut out_file = OpenOptions::new().create(true).write(true).truncate(true).open(&decrypt_target).map_err(|e| e.to_string())?;

  let cipher = Aes256::new_from_slice(&key).map_err(|e| e.to_string())?;
  let mut j0 = [0u8; 16];
  j0[..12].copy_from_slice(&iv);
  j0[15] = 1;
  let mut tag_mask = j0;
  cipher.encrypt_block((&mut tag_mask).into());

  let mut ctr_block = j0;
  inc32(&mut ctr_block);
  let mut ctr = Ctr128BE::<Aes256>::new_from_slices(&key, &ctr_block).map_err(|e| e.to_string())?;

  let h = derive_hash_subkey(&cipher);
  let mut ghash = GHash::new(GHashKey::from_slice(&h));
  let mut ghash_rem = Vec::new();
  let mut total_cipher_len: u64 = 0;

  let mut buffer = vec![0u8; 1024 * 1024];
  for part in sorted.iter() {
    let part_path = temp_dir.join(format!("part_{}", part.index));
    let mut file = std::fs::File::open(&part_path).map_err(|e| e.to_string())?;
    loop {
      let n = file.read(&mut buffer).map_err(|e| e.to_string())?;
      if n == 0 { break; }
      let chunk = &buffer[..n];
      total_cipher_len += n as u64;

      ghash_update(&mut ghash, &mut ghash_rem, chunk);

      let mut out = chunk.to_vec();
      ctr.apply_keystream(&mut out);
      out_file.write_all(&out).map_err(|e| e.to_string())?;
    }
  }

  ghash_finalize(&mut ghash, &mut ghash_rem, total_cipher_len);
  let tag = ghash.finalize();
  let mut expected = [0u8; 16];
  expected.copy_from_slice(tag.as_slice());
  for i in 0..16 {
    expected[i] ^= tag_mask[i];
  }
  if expected != auth_tag.as_slice() {
    let _ = std::fs::remove_file(&decrypt_target);
    return Err("auth_tag_mismatch".to_string());
  }

  if let Some(index) = file_index {
    extract_zip_entry(&decrypt_target, output_path, parts, index)?;
    let _ = std::fs::remove_file(&decrypt_target);
  } else {
    std::fs::rename(&decrypt_target, output_path).map_err(|e| e.to_string())?;
  }
  Ok(())
}

fn extract_zip_entry(zip_path: &Path, output_path: &Path, parts: &PartsResponse, file_index: usize) -> Result<(), String> {
  let target_name = parts.files.as_ref()
    .and_then(|files| files.get(file_index))
    .and_then(|file| file.originalName.clone())
    .unwrap_or_else(|| format!("file_{}", file_index + 1));
  let entry_name = target_name.replace(['\\', '/'], "_");

  let file = std::fs::File::open(zip_path).map_err(|e| e.to_string())?;
  let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

  let has_name = archive.file_names().any(|name| name == entry_name);
  let mut entry = if has_name {
    archive.by_name(&entry_name).map_err(|e| e.to_string())?
  } else {
    archive.by_index(file_index).map_err(|e| e.to_string())?
  };
  if entry.is_dir() {
    return Err("zip_entry_is_dir".to_string());
  }

  if let Some(parent) = output_path.parent() {
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }
  let mut out_file = OpenOptions::new().create(true).write(true).truncate(true).open(output_path).map_err(|e| e.to_string())?;
  std::io::copy(&mut entry, &mut out_file).map_err(|e| e.to_string())?;
  Ok(())
}

fn derive_hash_subkey(cipher: &Aes256) -> [u8; 16] {
  let mut block = [0u8; 16];
  cipher.encrypt_block((&mut block).into());
  block
}

fn inc32(block: &mut [u8; 16]) {
  let mut counter = u32::from_be_bytes([block[12], block[13], block[14], block[15]]);
  counter = counter.wrapping_add(1);
  let bytes = counter.to_be_bytes();
  block[12..16].copy_from_slice(&bytes);
}

fn ghash_update(ghash: &mut GHash, rem: &mut Vec<u8>, data: &[u8]) {
  rem.extend_from_slice(data);
  while rem.len() >= 16 {
    let block = GHashBlock::clone_from_slice(&rem[..16]);
    ghash.update(std::slice::from_ref(&block));
    rem.drain(..16);
  }
}

fn ghash_finalize(ghash: &mut GHash, rem: &mut Vec<u8>, cipher_len: u64) {
  if !rem.is_empty() {
    let mut block = [0u8; 16];
    block[..rem.len()].copy_from_slice(rem);
    let padded = GHashBlock::clone_from_slice(&block);
    ghash.update(std::slice::from_ref(&padded));
    rem.clear();
  }

  let mut len_block = [0u8; 16];
  let bit_len = cipher_len * 8;
  len_block[8..16].copy_from_slice(&bit_len.to_be_bytes());
  let len_block = GHashBlock::clone_from_slice(&len_block);
  ghash.update(std::slice::from_ref(&len_block));
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

fn emit_progress(app: &AppHandle, id: &str, downloaded: u64, total: Option<u64>, speed: u64, status: String, name: String) {
  let payload = DownloadProgress {
    id: id.to_string(),
    downloaded,
    total,
    speed,
    status,
    name
  };
  let _ = app.emit_all("download-progress", payload);
}

fn log_event(app: &AppHandle, level: &str, message: &str) {
  let payload = json!({ "level": level, "message": message });
  let _ = app.emit_all("client-log", payload);
  if level == "error" {
    eprintln!("[{}] {}", level, message);
  } else {
    println!("[{}] {}", level, message);
  }
  let mut wrote = false;
  if let Some(dir) = tauri::api::path::app_log_dir(&app.config()) {
    let _ = std::fs::create_dir_all(&dir);
    let log_path = dir.join("offload-client.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
      let _ = writeln!(file, "[{}] {}", level, message);
      wrote = true;
    }
  }
  if !wrote {
    if let Some(dir) = tauri::api::path::app_data_dir(&app.config()) {
      let _ = std::fs::create_dir_all(&dir);
      let log_path = dir.join("offload-client.log");
      if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = writeln!(file, "[{}] {}", level, message);
        wrote = true;
      }
    }
  }
  if !wrote {
    let dir = std::env::temp_dir().join("offload-disk-client");
    let _ = std::fs::create_dir_all(&dir);
    let log_path = dir.join("offload-client.log");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
      let _ = writeln!(file, "[{}] {}", level, message);
    }
  }
}

#[tauri::command]
fn client_log(app: AppHandle, level: String, message: String) {
  log_event(&app, &level, &message);
}

fn main() {
  tauri::Builder::default()
    .manage(DownloadManager::new())
    .manage(ApiState::new())
    .invoke_handler(tauri::generate_handler![
      login,
      list_folders,
      list_archives,
      start_archive_download,
      pause_download,
      list_downloads,
      client_log
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
