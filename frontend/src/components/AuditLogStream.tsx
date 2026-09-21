import React, { useState } from "react";
import { Download, ListFilter, Terminal, Trash2 } from "lucide-react";
import { AuditLogEntry } from "../types";

interface AuditLogStreamProps {
  logs: AuditLogEntry[];
  onClear: () => void;
}

export const AuditLogStream: React.FC<AuditLogStreamProps> = ({
  logs,
  onClear,
}) => {
  const [filter, setFilter] = useState<string>("all");

  const filteredLogs = logs.filter((l) => {
    if (filter === "all") return true;
    if (filter === "dispatch") return l.type === "dispatch" || l.type === "lock";
    if (filter === "transition") return l.type === "transition";
    if (filter === "concurrency") return l.type === "concurrency";
    if (filter === "error") return l.type === "error" || l.type === "revoke";
    return true;
  });

  const exportLogsAsJson = () => {
    const dataStr =
      "data:text/json;charset=utf-8," +
      encodeURIComponent(JSON.stringify(logs, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute(
      "download",
      `instaride_audit_log_${Date.now()}.json`
    );
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  return (
    <div className="bg-card border border-border rounded-2xl p-4 shadow-lg flex flex-col space-y-3">
      {/* Header & Filter Controls */}
      <div className="flex items-center justify-between flex-wrap gap-2 pb-2 border-b border-border">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-emerald-400" />
          <h3 className="font-bold text-sm text-zinc-200">
            Real-Time Audit Event Stream
          </h3>
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700">
            {filteredLogs.length} events
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Filter Pills */}
          <div className="flex items-center bg-[#090d16] border border-border rounded-lg p-0.5 text-[11px]">
            {["all", "dispatch", "transition", "concurrency", "error"].map(
              (cat) => (
                <button
                  key={cat}
                  onClick={() => setFilter(cat)}
                  className={`px-2 py-0.5 rounded-md capitalize font-medium transition ${
                    filter === cat
                      ? "bg-zinc-800 text-emerald-400 font-bold"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {cat}
                </button>
              )
            )}
          </div>

          {/* Action Buttons */}
          <button
            onClick={exportLogsAsJson}
            className="p-1.5 rounded-lg bg-[#090d16] border border-border hover:text-emerald-400 text-zinc-400 transition"
            title="Export JSON"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClear}
            className="p-1.5 rounded-lg bg-[#090d16] border border-border hover:text-rose-400 text-zinc-400 transition"
            title="Clear Stream"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Log Feed */}
      <div className="h-44 overflow-y-auto bg-[#090d16] border border-border rounded-xl p-2.5 font-mono text-[11px] space-y-1.5 text-zinc-300">
        {filteredLogs.length === 0 ? (
          <div className="text-zinc-600 text-center py-6">
            Waiting for live telemetry & audit transitions...
          </div>
        ) : (
          filteredLogs.map((item) => {
            let color = "text-zinc-400";
            if (item.type === "dispatch" || item.type === "lock")
              color = "text-amber-400";
            else if (item.type === "transition") color = "text-emerald-400";
            else if (item.type === "concurrency") color = "text-indigo-400";
            else if (item.type === "error" || item.type === "revoke")
              color = "text-rose-400";

            return (
              <div key={item.id} className="flex items-start gap-2 leading-relaxed">
                <span className="text-zinc-600 shrink-0 font-normal">
                  [{item.timestamp}]
                </span>
                <span
                  className={`font-semibold shrink-0 uppercase text-[9px] px-1.5 py-0.5 rounded border ${
                    item.type === "dispatch"
                      ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
                      : item.type === "transition"
                      ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                      : item.type === "concurrency"
                      ? "bg-indigo-500/10 text-indigo-400 border-indigo-500/30"
                      : item.type === "error"
                      ? "bg-rose-500/10 text-rose-400 border-rose-500/30"
                      : "bg-zinc-800 text-zinc-400 border-zinc-700"
                  }`}
                >
                  {item.type}
                </span>
                <span className={`${color} flex-1 break-words`}>
                  {item.message}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

