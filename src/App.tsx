import { useMemo, useState } from "react";

const mockDownloads = [
  {
    id: "d1",
    name: "Turkey Kemer 2018.zip",
    size: 6.1 * 1024 * 1024 * 1024,
    progress: 0.42,
    speed: 18.2 * 1024 * 1024,
    eta: "3m 12s",
    status: "Downloading"
  },
  {
    id: "d2",
    name: "Archive Photos 2022.zip",
    size: 2.4 * 1024 * 1024 * 1024,
    progress: 1,
    speed: 0,
    eta: "",
    status: "Completed"
  }
];

const mockRemote = [
  { id: "f1", type: "folder", name: "Backups" },
  { id: "f2", type: "folder", name: "Screenshots" },
  { id: "a1", type: "file", name: "MultiMC.zip", size: "15.6 GB", status: "ready" },
  { id: "a2", type: "file", name: "RImages.exe", size: "100 MB", status: "ready" }
];

function formatSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 2)} ${units[unit]}`;
}

export default function App() {
  const [filter, setFilter] = useState("all");
  const downloads = useMemo(() => {
    if (filter === "active") {
      return mockDownloads.filter((d) => d.progress < 1);
    }
    if (filter === "completed") {
      return mockDownloads.filter((d) => d.progress >= 1);
    }
    return mockDownloads;
  }, [filter]);

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
          <button className="primary">Add download</button>
          <button>Resume</button>
          <button>Pause</button>
          <button>Remove</button>
        </div>

        <div className="download-list">
          {downloads.map((item) => (
            <div key={item.id} className="download-card">
              <div className="download-title">
                <span className="status-dot" data-status={item.status.toLowerCase()} />
                <div>
                  <p className="file-name">{item.name}</p>
                  <p className="file-meta">{formatSize(item.size)} · {item.status}</p>
                </div>
              </div>
              <div className="progress-row">
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${item.progress * 100}%` }} />
                </div>
                <div className="progress-meta">
                  <span>{Math.round(item.progress * 100)}%</span>
                  {item.progress < 1 && <span>{formatSize(item.speed)}/s</span>}
                  {item.progress < 1 && <span>{item.eta}</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <main className="browser-panel">
        <div className="browser-header">
          <div>
            <p className="eyebrow">Remote Files</p>
            <h2>Server Browser</h2>
          </div>
          <div className="server-box">
            <input placeholder="Server URL" defaultValue="http://95.78.126.135:3010" />
            <button>Connect</button>
          </div>
        </div>

        <div className="breadcrumb">
          <span>Files</span>
          <span>/</span>
          <span>Root</span>
        </div>

        <div className="browser-table">
          <div className="table-head">
            <span>Name</span>
            <span>Status</span>
            <span>Size</span>
          </div>
          {mockRemote.map((item) => (
            <div key={item.id} className={`table-row ${item.type}`}>
              <span className="row-name">
                <span className={`icon ${item.type}`} />
                {item.name}
              </span>
              <span>{item.status || (item.type === "folder" ? "Folder" : "Ready")}</span>
              <span>{item.size || ""}</span>
            </div>
          ))}
        </div>

        <div className="drop-zone">
          <div>
            <p>Drag files from the right to the left to download.</p>
            <span>Supports pause/resume once server supports Range.</span>
          </div>
        </div>
      </main>
    </div>
  );
}