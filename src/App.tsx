import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/api/dialog";
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
  path?: string;
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
  const [downloads, setDownloads] = useState<Record<string, DownloadItem>>(() => {
    try {
      const raw = localStorage.getItem("downloads");
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  const [filter, setFilter] = useState("all");
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [notified, setNotified] = useState<Record<string, boolean>>({});
  const downloadsRef = useRef<HTMLDivElement | null>(null);
  const dragPayloadRef = useRef<string | null>(null);
  const [fileFilter, setFileFilter] = useState("all");
  const [selectedDownloads, setSelectedDownloads] = useState<string[]>([]);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteRemember, setDeleteRemember] = useState(localStorage.getItem("downloadDeleteRemember") === "1");
  const [manualDragPayload, setManualDragPayload] = useState<string | null>(null);
  const [manualDragOver, setManualDragOver] = useState(false);
  const [downloadMenu, setDownloadMenu] = useState<{ x: number; y: number; id: string } | null>(null);

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

  useEffect(() => {
    try {
      localStorage.setItem("downloads", JSON.stringify(downloads));
    } catch {}
  }, [downloads]);

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

  const handleDropPayload = (payload: string | null) => {
    const raw = payload || dragPayloadRef.current;
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.archiveId) {
        const name = currentEntries.find((entry) => entry.archiveId === parsed.archiveId && entry.fileIndex === parsed.fileIndex)?.name || "file";
        enqueueDownload(parsed.archiveId, name, parsed.fileIndex);
        dragPayloadRef.current = null;
        return;
      }
      if (parsed?.folderId) {
        const folderName = parsed.folderName || "folder";
        startFolderDownloadNow(parsed.folderId, folderName);
        dragPayloadRef.current = null;
      }
    } catch {}
  };

  const goUpFolder = () => {
    if (!currentFolderId) return;
    const current = folderMap[currentFolderId];
    const parent = current?.parentId ? normalizeId(current.parentId) : null;
    setCurrentFolderId(parent);
    loadRemote(parent);
  };

  const toggleDownloadSelection = (id: string) => {
    setSelectedDownloads((prev) => {
      if (prev.includes(id)) {
        return prev.filter((item) => item !== id);
      }
      return [...prev, id];
    });
  };

  const getDownloadPath = (item: DownloadItem) => {
    if (item.path) return item.path;
    if (!downloadPath) return item.name;
    return `${downloadPath.replace(/[\\/]+$/, "")}\\${item.name}`;
  };

  const applyDeleteSelection = async (action: "delete" | "remove") => {
    const ids = selectedDownloads.slice();
    if (ids.length === 0) return;
    if (action === "delete") {
      for (const id of ids) {
        const item = downloads[id];
        if (!item) continue;
        const path = getDownloadPath(item);
        try {
          await invoke("delete_path", { path });
        } catch (err) {
          addLog("warn", `Delete failed: ${String(err)}`);
        }
      }
    }
    setDownloads((prev) => {
      const next = { ...prev };
      ids.forEach((id) => { delete next[id]; });
      return next;
    });
    setSelectedDownloads([]);
  };

  const requestDeleteSelection = () => {
    if (selectedDownloads.length === 0) return;
    const remember = localStorage.getItem("downloadDeleteRemember") === "1";
    const choice = localStorage.getItem("downloadDeleteChoice");
    if (remember && (choice === "delete" || choice === "remove")) {
      applyDeleteSelection(choice as "delete" | "remove");
      return;
    }
    setDeleteDialogOpen(true);
  };

  const filteredEntries = useMemo(() => {
    const normalizeExt = (name: string) => {
      const idx = name.lastIndexOf(".");
      return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
    };
    const archiveExts = new Set(["zip", "rar", "7z", "tar", "gz", "bz2", "xz"]);
    const videoExts = new Set(["mp4", "mkv", "avi", "mov", "webm", "wmv", "flv", "m4v"]);
    const musicExts = new Set(["mp3", "flac", "wav", "aac", "ogg", "m4a", "opus"]);
    const statusLower = (value: string | undefined) => (value || "").toLowerCase();

    return currentEntries.filter((file) => {
      const status = statusLower(file.status);
      const ext = normalizeExt(file.name);
      switch (fileFilter) {
        case "missing":
          return status === "error" || status === "missing" || status === "lost";
        case "active":
          return ["queued", "processing", "uploading", "streaming", "pending"].includes(status);
        case "completed":
          return status === "ready";
        case "archives":
          return archiveExts.has(ext);
        case "video":
          return videoExts.has(ext);
        case "music":
          return musicExts.has(ext);
        default:
          return true;
      }
    });
  }, [currentEntries, fileFilter]);

  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    };
    const onDrop = (event: DragEvent) => {
      const target = downloadsRef.current;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const x = event.clientX;
      const y = event.clientY;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      event.preventDefault();
      const payload = event.dataTransfer?.getData("application/json") || event.dataTransfer?.getData("text/plain") || null;
      addLog("info", "Drop window");
      handleDropPayload(payload);
    };
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("drop", onDrop, true);
    document.addEventListener("dragover", onDragOver, true);
    document.addEventListener("drop", onDrop, true);
    return () => {
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("drop", onDrop, true);
      document.removeEventListener("dragover", onDragOver, true);
      document.removeEventListener("drop", onDrop, true);
    };
  }, [handleDropPayload]);

  useEffect(() => {
    if (!manualDragPayload) return;
    const prevCursor = document.body.style.cursor;
    document.body.style.cursor = "grabbing";
    const onMove = (event: MouseEvent) => {
      const target = downloadsRef.current;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      setManualDragOver(inside);
    };
    const onUp = () => {
      if (manualDragOver) {
        addLog("info", "Manual drop on downloads");
        handleDropPayload(manualDragPayload);
      }
      setManualDragPayload(null);
      setManualDragOver(false);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp, { once: true });
    return () => {
      document.body.style.cursor = prevCursor;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [manualDragPayload, manualDragOver, handleDropPayload]);

  useEffect(() => {
    if (!downloadMenu) return;
    const close = () => setDownloadMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [downloadMenu]);

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
        fileIndex
      });
      const targetPath = `${downloadPath.replace(/[\\/]+$/, "")}\\${name}`;
      setDownloads((prev) => ({
        ...prev,
        [id]: {
          id,
          name,
          downloaded: 0,
          total: 0,
          speed: 0,
          status: "queued",
          path: targetPath
        }
      }));
    } catch (err) {
      console.error(err);
      alert("Download start failed");
      addLog("error", `Download start failed: ${String(err)}`);
    }
  };

  const startFolderDownloadNow = async (folderId: string, folderName: string) => {
    if (!downloadPath) {
      alert("Set download folder first");
      return;
    }
    try {
      addLog("info", `Download queued: ${folderName}`);
      const fileName = `${folderName}.zip`;
      const id = await invoke<string>("start_folder_download", {
        folderId,
        folderName,
        downloadDir: downloadPath
      });
      const targetPath = `${downloadPath.replace(/[\\/]+$/, "")}\\${fileName}`;
      setDownloads((prev) => ({
        ...prev,
        [id]: {
          id,
          name: fileName,
          downloaded: 0,
          total: 0,
          speed: 0,
          status: "queued",
          path: targetPath
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
        data-drag-over={manualDragOver ? "true" : "false"}
        ref={downloadsRef}
        onDragOverCapture={(e) => {
          e.preventDefault();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = "copy";
            e.dataTransfer.effectAllowed = "copy";
          }
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          addLog("info", "Drag enter downloads");
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (e.dataTransfer) {
            e.dataTransfer.dropEffect = "copy";
            e.dataTransfer.effectAllowed = "copy";
          }
        }}
        onDropCapture={(e) => {
          e.preventDefault();
          const payload = e.dataTransfer.getData("application/json") || e.dataTransfer.getData("text/plain");
          addLog("info", "Drop on downloads");
          handleDropPayload(payload);
        }}
      >
        <div className="panel-header">
          <div>
            <p className="eyebrow">Downloads</p>
            <h1>Offload Client</h1>
          </div>
        </div>

        <div className="filter-row download-filter">
          <label>Фильтр загрузок</label>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
          </select>
        </div>

        <div className="download-actions">
          <button className="primary" disabled={!connected} onClick={() => loadRemote(currentFolderId)}>Refresh</button>
          <button onClick={() => Object.values(downloads).forEach((d) => pauseDownload(d.id))}>Pause All</button>
          <button disabled={selectedDownloads.length === 0} onClick={requestDeleteSelection}>Delete Selected</button>
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

        <div
          className="download-list"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const payload = e.dataTransfer.getData("application/json") || e.dataTransfer.getData("text/plain");
            handleDropPayload(payload);
          }}
        >
          {filteredDownloads.map((item) => {
            const pct = item.total ? Math.min(100, Math.floor((item.downloaded / item.total) * 100)) : 0;
            const eta = item.total && item.speed ? formatDuration((item.total - item.downloaded) / item.speed) : "";
            const isSelected = selectedDownloads.includes(item.id);
            return (
              <div
                key={item.id}
                className={`download-card ${isSelected ? "selected" : ""}`}
                onClick={(e) => {
                  if (e.detail > 1) return;
                  toggleDownloadSelection(item.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selectedDownloads.includes(item.id)) {
                    setSelectedDownloads([item.id]);
                  }
                  setDownloadMenu({ x: e.clientX, y: e.clientY, id: item.id });
                }}
                onDoubleClick={() => {
                  if (item.status !== "completed") return;
                  const path = downloadPath ? `${downloadPath.replace(/[\\/]+$/, "")}\\${item.name}` : item.name;
                  invoke("open_path", { path }).catch((err) => addLog("error", `Open failed: ${String(err)}`));
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

        <div className="filter-row">
          <label>Фильтр файлов</label>
          <select value={fileFilter} onChange={(e) => setFileFilter(e.target.value)}>
            <option value="all">All files</option>
            <option value="missing">Missing Files</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
            <option disabled>────────</option>
            <option value="archives">Archives</option>
            <option value="video">Video</option>
            <option value="music">Music</option>
          </select>
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
            <div className="table-row folder" onClick={goUpFolder}>
              <span className="row-name"><span className="icon folder" />..</span>
              <span>Folder</span>
              <span />
            </div>
          )}
          {currentFolders.map((folder) => (
            <div
              key={folder._id}
              className="table-row folder"
              draggable
              onDragStart={(e) => {
                const payload = JSON.stringify({ folderId: folder._id, folderName: folder.name });
                e.dataTransfer.setData("application/json", payload);
                e.dataTransfer.setData("text/plain", payload);
                e.dataTransfer.effectAllowed = "copy";
                dragPayloadRef.current = payload;
                addLog("info", `Drag start folder ${folder.name}`);
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                const payload = JSON.stringify({ folderId: folder._id, folderName: folder.name });
                dragPayloadRef.current = payload;
                setManualDragPayload(payload);
                addLog("info", `Drag start folder ${folder.name}`);
              }}
              onDragEnd={() => {
                dragPayloadRef.current = null;
              }}
              onClick={() => { const nextId = normalizeId(folder._id); setCurrentFolderId(nextId); loadRemote(nextId); }}
            >
              <span className="row-name"><span className="icon folder" />{folder.name}</span>
              <span>Folder</span>
              <span />
            </div>
          ))}
          {filteredEntries.map((file) => (
            <div
              key={file.key}
              className={`table-row file ${file.bundleId ? "bundle" : ""}`}
              style={file.bundleId ? { ["--bundle-hue" as any]: bundleHue(file.bundleId) } : undefined}
              draggable
              onDragStart={(e) => {
                const payload = JSON.stringify({ archiveId: file.archiveId, fileIndex: file.fileIndex });
                e.dataTransfer.setData("application/json", payload);
                e.dataTransfer.setData("text/plain", payload);
                e.dataTransfer.effectAllowed = "copy";
                dragPayloadRef.current = payload;
                addLog("info", `Drag start file ${file.name}`);
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                const payload = JSON.stringify({ archiveId: file.archiveId, fileIndex: file.fileIndex });
                dragPayloadRef.current = payload;
                setManualDragPayload(payload);
                addLog("info", `Drag start file ${file.name}`);
              }}
              onDragEnd={() => {
                dragPayloadRef.current = null;
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
            const payload = e.dataTransfer.getData("application/json") || e.dataTransfer.getData("text/plain");
            handleDropPayload(payload);
          }}
        >
          <div>
            <p>Drag files from the right to the left to download.</p>
            <span>Direct Discord download with relay fallback.</span>
          </div>
        </div>
      </main>

      {deleteDialogOpen && (
        <div className="modal" onClick={() => setDeleteDialogOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Delete selected downloads ({selectedDownloads.length})</h3>
            </div>
            <div className="modal-body">
              {selectedDownloads.map((id) => {
                const item = downloads[id];
                if (!item) return null;
                return (
                  <div key={id} className="modal-path">
                    {getDownloadPath(item)}
                  </div>
                );
              })}
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={deleteRemember}
                  onChange={(e) => {
                    const next = e.target.checked;
                    setDeleteRemember(next);
                    localStorage.setItem("downloadDeleteRemember", next ? "1" : "0");
                  }}
                />
                <span>Remember my choice</span>
              </label>
              <div className="modal-actions">
                <button onClick={() => setDeleteDialogOpen(false)}>Cancel</button>
                <button
                  onClick={() => {
                    localStorage.setItem("downloadDeleteChoice", "delete");
                    setDeleteDialogOpen(false);
                    applyDeleteSelection("delete");
                  }}
                >
                  DELETE FILES
                </button>
                <button
                  onClick={() => {
                    localStorage.setItem("downloadDeleteChoice", "remove");
                    setDeleteDialogOpen(false);
                    applyDeleteSelection("remove");
                  }}
                >
                  REMOVE FROM LIST
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {downloadMenu && (() => {
        const width = 220;
        const height = 160;
        const x = Math.min(downloadMenu.x, window.innerWidth - width - 8);
        const y = Math.min(downloadMenu.y, window.innerHeight - height - 8);
        const item = downloads[downloadMenu.id];
        const canOpen = item?.status === "completed";
        return (
          <div
            className="context-menu"
            style={{ left: x, top: y, width }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="menu-item"
              disabled={!canOpen}
              onClick={() => {
                if (!item) return;
                const path = getDownloadPath(item);
                invoke("open_path", { path }).catch((err) => addLog("error", `Open failed: ${String(err)}`));
                setDownloadMenu(null);
              }}
            >
              Open
            </button>
            <button
              className="menu-item danger"
              onClick={() => {
                setDownloadMenu(null);
                requestDeleteSelection();
              }}
            >
              Delete files
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setDownloadMenu(null);
                applyDeleteSelection("remove");
              }}
            >
              Remove from list
            </button>
          </div>
        );
      })()}
    </div>
  );
}
