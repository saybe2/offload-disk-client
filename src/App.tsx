import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
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
  const [serverUrl, setServerUrl] = useState(localStorage.getItem("serverUrl") || DEFAULT_SERVER);
  const [username, setUsername] = useState(localStorage.getItem("username") || "");
  const [password, setPassword] = useState("");
  const [masterKey, setMasterKey] = useState(localStorage.getItem("masterKey") || "");
  const [downloadPath, setDownloadPath] = useState(localStorage.getItem("downloadPath") || "");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [currentFolderId, setCurrentFolderId] = useState<string | null>(null);
  const [downloads, setDownloads] = useState<Record<string, DownloadItem>>({});
  const [filter, setFilter] = useState("all");

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
    downloadDir().then((dir) => {
      if (!downloadPath) {
        setDownloadPath(dir || "");
      }
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
    return folders.filter((f) => (f.parentId || null) === currentFolderId);
  }, [folders, currentFolderId]);

  const currentArchives = useMemo(() => {
    return archives.filter((a) => (a.folderId || null) === currentFolderId);
  }, [archives, currentFolderId]);

  const connect = async () => {
    if (!serverUrl || !username || !password || !masterKey) return;
    setConnecting(true);
    try {
      await invoke("login", { input: { serverUrl, username, password, masterKey } });
      localStorage.setItem("serverUrl", serverUrl);
      localStorage.setItem("username", username);
      localStorage.setItem("masterKey", masterKey);
      if (downloadPath) localStorage.setItem("downloadPath", downloadPath);
      setConnected(true);
      await loadRemote(null);
    } catch (err) {
      console.error(err);
      alert("Login failed");
    } finally {
      setConnecting(false);
    }
  };

  const loadRemote = async (folderId: string | null) => {
    const foldersResp = await invoke<unknown>("list_folders");
    const archivesResp = await invoke<unknown>("list_archives", { folderId });
    const folderData = (foldersResp as any).folders || [];
    const archiveData = (archivesResp as any).archives || [];
    setFolders(folderData);
    setArchives(archiveData);
  };

  const pickDownloadDir = async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected === "string") {
      setDownloadPath(selected);
      localStorage.setItem("downloadPath", selected);
    }
  };

  const startDownload = async (archiveId: string, name: string) => {
    if (!downloadPath) {
      alert("Set download folder first");
      return;
    }
    try {
      const id = await invoke<string>("start_archive_download", {
        archiveId,
        downloadDir: downloadPath
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
    }
  };

  const pauseDownload = async (id: string) => {
    await invoke("pause_download", { id });
  };

  return (
    <div className="app-shell">
      <aside className="downloads-panel">
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
        </div>

        <div className="download-list">
          {filteredDownloads.map((item) => {
            const pct = item.total ? Math.min(100, Math.floor((item.downloaded / item.total) * 100)) : 0;
            const eta = item.total && item.speed ? formatDuration((item.total - item.downloaded) / item.speed) : "";
            return (
              <div key={item.id} className="download-card">
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
            <button onClick={connect} disabled={connecting}>Connect</button>
          </div>
        </div>

        <div className="auth-row">
          <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} />
          <input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <input placeholder="Master key" value={masterKey} onChange={(e) => setMasterKey(e.target.value)} />
          <input placeholder="Download folder" value={downloadPath} onChange={(e) => setDownloadPath(e.target.value)} />
        </div>

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
            <div key={folder._id} className="table-row folder" onClick={() => { setCurrentFolderId(folder._id); loadRemote(folder._id); }}>
              <span className="row-name"><span className="icon folder" />{folder.name}</span>
              <span>Folder</span>
              <span />
            </div>
          ))}
          {currentArchives.map((file) => {
            const name = file.displayName || file.downloadName || file.name || "file";
            const size = file.originalSize || file.files?.[0]?.size;
            return (
              <div
                key={file._id}
                className="table-row file"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/plain", file._id);
                }}
                onDoubleClick={() => startDownload(file._id, name)}
              >
                <span className="row-name"><span className="icon file" />{name}</span>
                <span>{file.status}</span>
                <span>{formatSize(size)}</span>
              </div>
            );
          })}
        </div>

        <div
          className="drop-zone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const archiveId = e.dataTransfer.getData("text/plain");
            const file = currentArchives.find((a) => a._id === archiveId);
            if (file) {
              const name = file.displayName || file.downloadName || file.name || "file";
              startDownload(file._id, name);
            }
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