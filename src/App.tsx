import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
import { open as openExternal } from "@tauri-apps/api/shell";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/api/notification";
import { downloadDir } from "@tauri-apps/api/path";

const DEFAULT_SERVER = "http://95.78.126.135:3010";

type Folder = { _id: string; name: string; parentId?: string | null };

type Archive = {
  _id: string;
  displayName?: string;
  downloadName?: string;
  name?: string;
  status: string;
  originalSize?: number;
  folderId?: string | null;
  isBundle?: boolean;
  files?: { originalName?: string; size?: number }[];
};

type DownloadItem = {
  id: string;
  name: string;
  downloaded: number;
  total?: number;
  speed: number;
  status: string;
};

type LogItem = {
  ts: string;
  level: "info" | "error" | "warn";
  message: string;
};

type LogEntry = {
  ts: string;
  level: string;
  message: string;
};
function formatSize(bytes?: number) {
  if (!bytes && bytes !== 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.max(0, Math.round(seconds));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) return `${hrs}h ${String(mins).padStart(2, "0")}m`;
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

export default function App() {
  const normalizeId = (value: any) => {
    if (!value) return null;
    if (typeof value === "string") return value;
    if (typeof value === "object") {
      if (value.$oid) return value.$oid;
      if (value._id) return String(value._id);
    }
    return String(value);
  };

  const [serverUrl, setServerUrl] = useState(localStorage.getItem("serverUrl") || DEFAULT_SERVER);
  const [username, setUsername] = useState(localStorage.getItem("username") || "");
  const [password, setPassword] = useState(localStorage.getItem("password") || "");
  const [downloadPath, setDownloadPath] = useState(localStorage.getItem("downloadPath") || "");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [autoLoginTried, setAutoLoginTried] = useState(false);
  const [maxConcurrent, setMaxConcurrent] = useState(() => {
    const raw = localStorage.getItem("maxConcurrent");
    const parsed = raw ? Number(raw) : 2;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
  });
  const [queue, setQueue] = useState<{ archiveId: string; name: string; fileIndex?: number }[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DownloadItem>>({});
  const [filter, setFilter] = useState("all");
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [notified, setNotified] = useState<Record<string, boolean>>({});

  const addLog = (level: LogItem["level"], message: string) => {
    const ts = new Date().toLocaleTimeString();
    setLogs((prev) => {
      const next = [...prev, { ts, level, message }].slice(-200);
      return next;
    });
    const line = `[${ts}] ${level.toUpperCase()} ${message}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
    invoke("client_log", { level, message }).catch(() => undefined);
  };

  useEffect(() => {
    const unlisten = listen<DownloadItem>("download-progress", (event) => {
      setDownloads((prev) => ({
        ...prev,
        [event.payload.id]: {
          ...prev[event.payload.id],
          ...event.payload
        }
      }));
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const completed = Object.values(downloads).filter((d) => d.status === "completed");
    if (completed.length === 0) return;
    completed.forEach((item) => {
      if (notified[item.id]) return;
      setNotified((prev) => ({ ...prev, [item.id]: true }));
      const notify = async () => {
        try {
          let granted = await isPermissionGranted();
          if (!granted) {
            const result = await requestPermission();
            granted = result === "granted";
          }
          if (granted) {
            sendNotification({
              title: "Offload Disk Client",
              body: `Загрузка завершена: ${item.name}`
            });
          }
        } catch (err) {
          addLog("warn", `Notification failed: ${String(err)}`);
        }
      };
      notify();
    });
  }, [downloads, notified]);

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      addLog("error", `UI error: ${event.message}`);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      addLog("error", `Unhandled rejection: ${String(event.reason)}`);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  useEffect(() => {
    downloadDir()
      .then((dir) => {
        if (!downloadPath) {
          setDownloadPath(dir || "");
        }
      })
      .catch((err) => {
        addLog("warn", `downloadDir failed: ${String(err)}`);
      });
  }, [downloadPath]);

  const filteredDownloads = useMemo(() => {
    const list = Object.values(downloads);
    if (filter === "active") return list.filter((d) => d.status !== "completed");
    if (filter === "completed") return list.filter((d) => d.status === "completed");
    return list;
  }, [downloads, filter]);

  const folderMap = useMemo(() => {
    const map: Record<string, Folder> = {};
    folders.forEach((f) => { map[f._id] = f; });
    return map;
  }, [folders]);

  const breadcrumb = useMemo(() => {
    if (!currentFolderId) return ["Files"];
    const chain = [] as string[];
    let current: Folder | undefined = folderMap[currentFolderId];
    while (current) {
      chain.unshift(current.name);
      current = current.parentId ? folderMap[current.parentId] : undefined;
    }
    return ["Files", ...chain];
  }, [currentFolderId, folderMap]);

  const currentFolders = useMemo(() => {
    return folders.filter((f) => (normalizeId(f.parentId) || null) === currentFolderId);
  }, [folders, currentFolderId]);

  const currentArchives = useMemo(() => {
    return archives.filter((a) => (normalizeId(a.folderId) || null) === currentFolderId);
  }, [archives, currentFolderId]);

  const bundleHue = (bundleId: string) => {
    let hash = 0;
    for (let i = 0; i < bundleId.length; i += 1) {
      hash = (hash * 31 + bundleId.charCodeAt(i)) % 360;
    }
    return hash;
  };

  const currentEntries = useMemo(() => {
    const entries: { key: string; archiveId: string; fileIndex?: number; name: string; status: string; size?: number; bundleId?: string }[] = [];
    currentArchives.forEach((archive) => {
      if (archive.isBundle && archive.files && archive.files.length > 1) {
        archive.files.forEach((file, index) => {
          const name = file.originalName || `file_${index + 1}`;
          entries.push({
            key: `${archive._id}_${index}`,
            archiveId: archive._id,
            fileIndex: index,
            name,
            status: archive.status,
            size: file.size,
            bundleId: archive._id
          });
        });
      } else {
        const name = archive.displayName || archive.downloadName || archive.name || "file";
        const size = archive.originalSize || archive.files?.[0]?.size;
        entries.push({
          key: archive._id,
          archiveId: archive._id,
          name,
          status: archive.status,
          size
        });
      }
    });
    return entries;
  }, [currentArchives]);

  const connect = async (silent = false) => {
    if (!serverUrl || !username || !password) return;
    setConnecting(true);
    setLoginError("");
    setLoadError("");
    try {
      addLog("info", "Login start");
      const key = await invoke<string>("login", { input: { server_url: serverUrl, username, password } });
      localStorage.setItem("serverUrl", serverUrl);
      localStorage.setItem("username", username);
      localStorage.setItem("password", password);
      localStorage.setItem("masterKey", key);
      if (downloadPath) localStorage.setItem("downloadPath", downloadPath);
      setConnected(true);
      await loadRemote(null);
      addLog("info", "Login success");
    } catch (err) {
      console.error(err);
      if (!silent) {
        const message = String(err);
        if (message.includes("master_key_unavailable")) {
          setLoginError("Server did not allow master key export. Enable MASTER_KEY_EXPORT=true.");
        } else {
          setLoginError("Login failed");
        }
      }
      setConnected(false);
      addLog("error", `Login failed: ${String(err)}`);
    } finally {
      setConnecting(false);
    }
  };

  useEffect(() => {
    if (autoLoginTried) return;
    setAutoLoginTried(true);
    if (serverUrl && username && password) {
      connect(true);
    }
  }, [autoLoginTried, serverUrl, username, password]);

  const loadRemote = async (folderId: string | null) => {
    try {
      addLog("info", `Loading folders and files (${folderId || "root"})`);
      const foldersResp = await invoke<unknown>("list_folders");
      const archivesResp = await invoke<unknown>("list_archives");
      const folderDataRaw = Array.isArray((foldersResp as any).folders)
        ? (foldersResp as any).folders
        : (Array.isArray(foldersResp) ? foldersResp : []);
      const archiveDataRaw = Array.isArray((archivesResp as any).archives)
        ? (archivesResp as any).archives
        : (Array.isArray(archivesResp) ? archivesResp : []);
      const folderData = folderDataRaw.map((f: any) => ({
        ...f,
        _id: normalizeId(f._id),
        parentId: normalizeId(f.parentId)
      }));
      const archiveData = archiveDataRaw.map((a: any) => ({
        ...a,
        _id: normalizeId(a._id),
        folderId: normalizeId(a.folderId)
      }));
      setFolders(folderData);
      setArchives(archiveData);
      setLoadError("");
      addLog("info", `Loaded folders=${folderData.length} archives=${archiveData.length}`);
    } catch (err) {
      console.error(err);
      setLoadError("Failed to load remote data. Check server and credentials.");
      addLog("error", `Load failed: ${String(err)}`);
      throw err;
    }
  };

  const pickDownloadDir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setDownloadPath(selected);
      localStorage.setItem("downloadPath", selected);
    }
  };

  const startDownloadNow = async (archiveId: string, name: string, fileIndex?: number) => {
    if (!downloadPath) {
      alert("Set download folder first");
      return;
    }
    try {
      addLog("info", `Download queued: ${name}`);
      const id = await invoke<string>("start_archive_download", {
        archiveId,
        downloadDir: downloadPath,
        file_index: fileIndex
      });
      setDownloads((prev) => ({
        ...prev,
        [id]: {
          id,
          name,
          downloaded: 0,
          total: 0,
          speed: 0,
          status: "queued"
        }
      }));
    } catch (err) {
      console.error(err);
      alert("Download start failed");
      addLog("error", `Download start failed: ${String(err)}`);
    }
  };


  const enqueueDownload = (archiveId: string, name: string, fileIndex?: number) => {
    const active = Object.values(downloads).filter((d) => !["completed", "error", "paused"].includes(d.status)).length;
    if (active >= maxConcurrent) {
      setQueue((prev) => [...prev, { archiveId, name, fileIndex }]);
    } else {
      startDownloadNow(archiveId, name, fileIndex);
    }
  };

  useEffect(() => {
    const active = Object.values(downloads).filter((d) => !["completed", "error", "paused"].includes(d.status)).length;
    if (queue.length === 0) return;
    if (active >= maxConcurrent) return;
    const next = queue[0];
    setQueue((prev) => prev.slice(1));
    startDownloadNow(next.archiveId, next.name, next.fileIndex);
  }, [downloads, queue, maxConcurrent]);

  useEffect(() => {
    localStorage.setItem("maxConcurrent", String(maxConcurrent));
  }, [maxConcurrent]);

  const pauseDownload = async (id: string) => {
    await invoke("pause_download", { id });
  };

  if (!connected) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <h1>Offload Disk Client</h1>
          <p>Sign in to your server</p>
          <label>Server URL</label>
          <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://server:3010" />
          <label>Username</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <label>Download folder</label>
          <div className="login-row">
            <input value={downloadPath} onChange={(e) => setDownloadPath(e.target.value)} placeholder="C:\\Downloads" />
            <button onClick={pickDownloadDir}>Browse</button>
          </div>
          {loginError && <div className="login-error">{loginError}</div>}
          <button className="primary" onClick={() => connect(false)} disabled={connecting}>
            {connecting ? "Connecting..." : "Login"}
          </button>
          <p className="login-hint">Credentials are stored locally to auto-login next time.</p>
        </div>
      </div>
    );
  }


    return (
      <div className="app-shell">
      <aside
        className="downloads-panel"
        onDragOverCapture={(e) => e.preventDefault()}
        onDropCapture={(e) => {
          e.preventDefault();
          const payload = e.dataTransfer.getData("application/json") || e.dataTransfer.getData("text/plain");
          try {
            const parsed = JSON.parse(payload);
            if (parsed?.archiveId) {
              const name = currentEntries.find((entry) => entry.archiveId === parsed.archiveId && entry.fileIndex === parsed.fileIndex)?.name || "file";
              enqueueDownload(parsed.archiveId, name, parsed.fileIndex);
            }
          } catch {}
        }}
      >
        <div className="panel-header">
          <div>
            <p className="eyebrow">Downloads</p>
            <h1>Offload Client</h1>
          </div>
          <div className="chip-row">
            <button className={filter === "all" ? "chip active" : "chip"} onClick={() => setFilter("all")}>
              All
            </button>
            <button className={filter === "active" ? "chip active" : "chip"} onClick={() => setFilter("active")}>
              Active
            </button>
            <button className={filter === "completed" ? "chip active" : "chip"} onClick={() => setFilter("completed")}>
              Completed
            </button>
          </div>
        </div>

        <div className="download-actions">
          <button className="primary" disabled={!connected} onClick={() => loadRemote(currentFolderId)}>Refresh</button>
          <button onClick={() => Object.values(downloads).forEach((d) => pauseDownload(d.id))}>Pause All</button>
          <button onClick={pickDownloadDir}>Set folder</button>
          <div className="concurrency">
            <span>Parallel</span>
            <input
              type="number"
              min={1}
              max={8}
              value={maxConcurrent}
              onChange={(e) => setMaxConcurrent(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
        </div>

        <div className="download-list">
          {filteredDownloads.map((item) => {
            const pct = item.total ? Math.min(100, Math.floor((item.downloaded / item.total) * 100)) : 0;
            const eta = item.total && item.speed ? formatDuration((item.total - item.downloaded) / item.speed) : "";
            return (
              <div
                key={item.id}
                className="download-card"
                onDoubleClick={() => {
                  if (item.status !== "completed") return;
                  const path = downloadPath ? `${downloadPath.replace(/[\\/]+$/, "")}\\${item.name}` : item.name;
                  openExternal(path).catch((err) => addLog("error", `Open failed: ${String(err)}`));
                }}
              >
                <div className="download-title">
                  <span className="status-dot" data-status={item.status.toLowerCase()} />
                  <div>
                    <p className="file-name">{item.name}</p>
                    <p className="file-meta">{formatSize(item.total)} · {item.status}</p>
                  </div>
                </div>
                <div className="progress-row">
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <div className="progress-meta">
                    <span>{pct}%</span>
                    {item.status !== "completed" && <span>{formatSize(item.speed)}/s</span>}
                    {item.status !== "completed" && <span>{eta}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

      </aside>

      <main className="browser-panel">
        <div className="browser-header">
          <div>
            <p className="eyebrow">Remote Files</p>
            <h2>Server Browser</h2>
          </div>
          <div className="server-box">
            <input placeholder="Server URL" value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} />
            <button onClick={() => connect(false)} disabled={connecting}>Connect</button>
          </div>
        </div>

        {loadError && (
          <div className="login-error">{loadError}</div>
        )}

        <div className="breadcrumb">
          {breadcrumb.map((item, index) => (
            <span key={`${item}-${index}`}>{item}{index < breadcrumb.length - 1 ? " / " : ""}</span>
          ))}
        </div>

        <div className="browser-table">
          <div className="table-head">
            <span>Name</span>
            <span>Status</span>
            <span>Size</span>
          </div>
          {currentFolderId && (
            <div className="table-row folder" onClick={() => { setCurrentFolderId(null); loadRemote(null); }}>
              <span className="row-name"><span className="icon folder" />..</span>
              <span>Folder</span>
              <span />
            </div>
          )}
          {currentFolders.map((folder) => (
            <div key={folder._id} className="table-row folder" onClick={() => { const nextId = normalizeId(folder._id); setCurrentFolderId(nextId); loadRemote(nextId); }}>
              <span className="row-name"><span className="icon folder" />{folder.name}</span>
              <span>Folder</span>
              <span />
            </div>
          ))}
          {currentEntries.map((file) => (
            <div
              key={file.key}
              className={`table-row file ${file.bundleId ? "bundle" : ""}`}
              style={file.bundleId ? { ["--bundle-hue" as any]: bundleHue(file.bundleId) } : undefined}
              draggable
              onDragStart={(e) => {
                const payload = JSON.stringify({ archiveId: file.archiveId, fileIndex: file.fileIndex });
                e.dataTransfer.effectAllowed = "copy";
                e.dataTransfer.setData("application/json", payload);
                e.dataTransfer.setData("text/plain", payload);
              }}
              onDoubleClick={() => enqueueDownload(file.archiveId, file.name, file.fileIndex)}
            >
              <span className="row-name"><span className="icon file" />{file.name}</span>
              <span>{file.status}</span>
              <span>{formatSize(file.size)}</span>
            </div>
          ))}
        </div>

        <div
          className="drop-zone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const payload = e.dataTransfer.getData("text/plain");
            try {
              const parsed = JSON.parse(payload);
              if (parsed?.archiveId) {
                const name = currentEntries.find((entry) => entry.archiveId === parsed.archiveId && entry.fileIndex === parsed.fileIndex)?.name || "file";
                enqueueDownload(parsed.archiveId, name, parsed.fileIndex);
                return;
              }
            } catch {}
          }}
        >
          <div>
            <p>Drag files from the right to the left to download.</p>
            <span>Direct Discord download with relay fallback.</span>
          </div>
        </div>
      </main>
    </div>
  );
}
