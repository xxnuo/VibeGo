import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Network,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Skull,
  Timer,
  Trash2,
} from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import type { ForwardRule, PortInfo } from "@/api/port";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePageTopBar } from "@/hooks/use-page-top-bar";
import {
  useAddForward,
  useForwardList,
  useKillProcess,
  usePortList,
  useRemoveForward,
  useToggleForward,
} from "@/hooks/use-port";
import { useTranslation } from "@/lib/i18n";
import { registerPage } from "@/pages/registry";
import type { PageViewProps } from "@/pages/types";
import { useAppStore } from "@/stores/app-store";

function getRefreshOptions(t: (key: string) => string) {
  return [
    { value: "0", label: t("plugin.processMonitor.refreshManual") },
    { value: "2000", label: "2s" },
    { value: "5000", label: "5s" },
    { value: "10000", label: "10s" },
  ];
}

function getProtocolColor(protocol: string) {
  switch (protocol.toLowerCase()) {
    case "tcp":
      return "bg-blue-500/20 text-blue-500";
    case "udp":
      return "bg-purple-500/20 text-purple-500";
    case "http":
      return "bg-green-500/20 text-green-500";
    default:
      return "bg-gray-500/20 text-gray-500";
  }
}

const PortRow: React.FC<{
  port: PortInfo;
  t: (key: string) => string;
  onKill: (pid: number) => void;
  onCreateForward: (port: number) => void;
  killing: boolean;
}> = ({ port, t, onKill, onCreateForward, killing }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-b border-ide-border">
      <button
        type="button"
        className="w-full flex items-center px-3 sm:px-4 py-2.5 sm:py-2 hover:bg-ide-panel/50 transition-colors cursor-pointer text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="w-5 shrink-0 flex items-center">
          {expanded ? (
            <ChevronDown size={14} className="text-ide-mute" />
          ) : (
            <ChevronRight size={14} className="text-ide-mute" />
          )}
        </div>
        <div className="w-16 sm:w-20 shrink-0">
          <span className="font-mono font-semibold text-sm text-ide-text">{port.port}</span>
        </div>
        <div className="w-14 sm:w-16 shrink-0">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getProtocolColor(port.protocol)}`}>
            {port.protocol.toUpperCase()}
          </span>
        </div>
        <div className="hidden sm:block flex-1 min-w-0 text-xs text-ide-mute truncate font-mono">{port.localAddr}</div>
        <div className="hidden sm:block w-16 shrink-0">
          {port.status && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-500/15 text-green-500">
              {t("plugin.portManager.listening")}
            </span>
          )}
        </div>
        <div className="hidden sm:block w-16 shrink-0 text-xs text-ide-mute font-mono">
          {port.pid > 0 ? port.pid : "-"}
        </div>
        <div className="flex-1 sm:flex-none sm:w-32 shrink-0 text-xs text-ide-text truncate">
          {port.processName || "-"}
          <span className="sm:hidden text-ide-mute ml-1">{port.pid > 0 && `(${port.pid})`}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-3 sm:px-4 pb-3 pt-1 bg-ide-panel/30">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-xs mb-3">
            <div>
              <span className="text-ide-mute block">{t("plugin.portManager.port")}</span>
              <span className="text-ide-text font-mono font-semibold">{port.port}</span>
            </div>
            <div>
              <span className="text-ide-mute block">{t("plugin.portManager.protocol")}</span>
              <span className="text-ide-text font-mono">{port.protocol.toUpperCase()}</span>
            </div>
            <div>
              <span className="text-ide-mute block">{t("plugin.portManager.localAddr")}</span>
              <span className="text-ide-text font-mono">{port.localAddr}</span>
            </div>
            <div>
              <span className="text-ide-mute block">{t("plugin.portManager.status")}</span>
              <span className="text-green-500">{port.status || "-"}</span>
            </div>
            <div>
              <span className="text-ide-mute block">{t("plugin.portManager.pid")}</span>
              <span className="text-ide-text font-mono">{port.pid > 0 ? port.pid : "-"}</span>
            </div>
            <div>
              <span className="text-ide-mute block">{t("plugin.portManager.processName")}</span>
              <span className="text-ide-text">{port.processName || "-"}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {port.protocol === "tcp" && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={(e) => {
                  e.stopPropagation();
                  const addr = port.localAddr.startsWith("0.0.0.0")
                    ? `localhost:${port.port}`
                    : port.localAddr.startsWith("[::]")
                      ? `localhost:${port.port}`
                      : port.localAddr;
                  window.open(`http://${addr}`, "_blank");
                }}
              >
                <ExternalLink size={12} />
                {t("plugin.portManager.openInBrowser")}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={(e) => {
                e.stopPropagation();
                onCreateForward(port.port);
              }}
            >
              <ArrowRightLeft size={12} />
              {t("plugin.portManager.createForward")}
            </Button>
            {port.pid > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs gap-1 text-red-500 border-red-500/30 hover:bg-red-500/10 hover:text-red-600"
                onClick={(e) => {
                  e.stopPropagation();
                  onKill(port.pid);
                }}
                disabled={killing}
              >
                <Skull size={12} />
                {t("plugin.portManager.killProcess")}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

const PortManagerView: React.FC<PageViewProps> = () => {
  const locale = useAppStore((s) => s.locale);
  const t = useTranslation(locale);
  const refreshOptions = useMemo(() => getRefreshOptions(t), [t]);

  const [refreshInterval, setRefreshInterval] = useState<number>(5000);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTab, setActiveTab] = useState("ports");

  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [killDialogOpen, setKillDialogOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<ForwardRule | null>(null);
  const [killTarget, setKillTarget] = useState<number>(0);

  const [newListenPort, setNewListenPort] = useState("");
  const [newProtocol, setNewProtocol] = useState("tcp");
  const [newTargetAddr, setNewTargetAddr] = useState("");
  const [addError, setAddError] = useState("");

  const { data: portData, refetch: refetchPorts, isLoading: portsLoading } = usePortList(refreshInterval || undefined);
  const {
    data: forwardData,
    refetch: refetchForwards,
    isLoading: forwardsLoading,
  } = useForwardList(refreshInterval || undefined);
  const addForwardMutation = useAddForward();
  const removeForwardMutation = useRemoveForward();
  const toggleForwardMutation = useToggleForward();
  const killProcessMutation = useKillProcess();

  const handleRefresh = useCallback(() => {
    refetchPorts();
    refetchForwards();
  }, [refetchPorts, refetchForwards]);

  const isLoading = portsLoading || forwardsLoading;

  usePageTopBar(
    {
      show: true,
      centerContent: t("plugin.portManager.title"),
      rightButtons: [
        {
          icon: isLoading ? <RefreshCw size={18} className="animate-spin" /> : <RefreshCw size={18} />,
          title: t("plugin.portManager.refresh"),
          onClick: handleRefresh,
        },
      ],
    },
    [t, isLoading, handleRefresh]
  );

  const filteredPorts = useMemo(() => {
    if (!portData?.ports) return [];
    if (!searchTerm) return portData.ports;
    const lower = searchTerm.toLowerCase();
    return portData.ports.filter(
      (p: PortInfo) =>
        p.port.toString().includes(lower) ||
        p.protocol.toLowerCase().includes(lower) ||
        p.processName.toLowerCase().includes(lower) ||
        p.localAddr.toLowerCase().includes(lower) ||
        p.pid.toString().includes(lower)
    );
  }, [portData, searchTerm]);

  const filteredForwards = useMemo(() => {
    if (!forwardData?.forwards) return [];
    if (!searchTerm) return forwardData.forwards;
    const lower = searchTerm.toLowerCase();
    return forwardData.forwards.filter(
      (f: ForwardRule) =>
        f.listenPort.toString().includes(lower) ||
        f.protocol.toLowerCase().includes(lower) ||
        f.targetAddr.toLowerCase().includes(lower)
    );
  }, [forwardData, searchTerm]);

  const handleAddForward = useCallback(() => {
    const port = Number.parseInt(newListenPort, 10);
    if (!port || !newTargetAddr) return;
    setAddError("");

    addForwardMutation.mutate(
      {
        listenPort: port,
        protocol: newProtocol,
        targetAddr: newTargetAddr,
        enabled: true,
      },
      {
        onSuccess: () => {
          setAddDialogOpen(false);
          setNewListenPort("");
          setNewProtocol("tcp");
          setNewTargetAddr("");
          setAddError("");
        },
        onError: (err: Error) => {
          setAddError(err.message || "Failed to create forward rule");
        },
      }
    );
  }, [newListenPort, newProtocol, newTargetAddr, addForwardMutation]);

  const handleRemoveForward = useCallback(() => {
    if (!removeTarget) return;
    removeForwardMutation.mutate(removeTarget.id, {
      onSuccess: () => {
        setRemoveDialogOpen(false);
        setRemoveTarget(null);
      },
    });
  }, [removeTarget, removeForwardMutation]);

  const handleToggleForward = useCallback(
    (id: string, enabled: boolean) => {
      toggleForwardMutation.mutate({ id, enabled });
    },
    [toggleForwardMutation]
  );

  const handleKillProcess = useCallback(() => {
    if (!killTarget) return;
    killProcessMutation.mutate(killTarget, {
      onSuccess: () => {
        setKillDialogOpen(false);
        setKillTarget(0);
      },
    });
  }, [killTarget, killProcessMutation]);

  const handleCreateForwardFromPort = useCallback((portNum: number) => {
    setNewTargetAddr(`localhost:${portNum}`);
    setNewListenPort("");
    setNewProtocol("tcp");
    setAddError("");
    setAddDialogOpen(true);
    setActiveTab("forwards");
  }, []);

  const handleOpenForward = useCallback((fwd: ForwardRule) => {
    const protocol = window.location.protocol || "http:";
    const hostname = window.location.hostname || "localhost";
    window.open(`${protocol}//${hostname}:${fwd.listenPort}`, "_blank");
  }, []);

  return (
    <div className="h-full flex flex-col bg-ide-bg overflow-hidden">
      <div className="shrink-0 px-3 sm:px-4 py-2 border-b border-ide-border">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className="relative flex-1 sm:flex-none">
            <Search
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-ide-mute sm:w-4 sm:h-4 sm:left-2.5"
            />
            <Input
              placeholder={t("plugin.portManager.search")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full sm:w-40 md:w-48 pl-7 sm:pl-8 h-7 sm:h-8 text-xs sm:text-sm bg-ide-panel border-ide-border"
            />
          </div>
          <Select value={refreshInterval.toString()} onValueChange={(v) => setRefreshInterval(Number(v))}>
            <SelectTrigger className="w-16 sm:w-20 h-7 sm:h-8 text-xs sm:text-sm bg-ide-panel border-ide-border">
              <Timer size={12} className="mr-0.5 sm:mr-1 sm:w-3.5 sm:h-3.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {refreshOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
          <div className="shrink-0 px-3 sm:px-4 pt-2">
            <TabsList>
              <TabsTrigger value="ports" className="text-xs gap-1">
                <Network size={14} />
                {t("plugin.portManager.ports")}
                {portData?.ports && (
                  <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-ide-border">
                    {portData.ports.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="forwards" className="text-xs gap-1">
                <ArrowRightLeft size={14} />
                {t("plugin.portManager.forwards")}
                {forwardData?.forwards && forwardData.forwards.length > 0 && (
                  <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-ide-border">
                    {forwardData.forwards.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="ports" className="flex-1 overflow-hidden mt-0 px-0">
            <div className="h-full overflow-auto">
              <div className="hidden sm:flex items-center px-3 sm:px-4 py-2 border-b border-ide-border bg-ide-bg text-xs font-medium text-ide-mute sticky top-0 z-10">
                <div className="w-5 shrink-0" />
                <div className="w-20 shrink-0">{t("plugin.portManager.port")}</div>
                <div className="w-16 shrink-0">{t("plugin.portManager.protocol")}</div>
                <div className="flex-1 min-w-0">{t("plugin.portManager.localAddr")}</div>
                <div className="w-16 shrink-0">{t("plugin.portManager.status")}</div>
                <div className="w-16 shrink-0">{t("plugin.portManager.pid")}</div>
                <div className="w-32 shrink-0">{t("plugin.portManager.processName")}</div>
              </div>

              {filteredPorts.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-ide-mute text-sm">
                  {isLoading ? t("plugin.portManager.loading") : t("plugin.portManager.noListeningPorts")}
                </div>
              ) : (
                filteredPorts.map((port: PortInfo, idx: number) => (
                  <PortRow
                    key={`${port.port}-${port.protocol}-${idx}`}
                    port={port}
                    t={t}
                    onKill={(pid) => {
                      setKillTarget(pid);
                      setKillDialogOpen(true);
                    }}
                    onCreateForward={handleCreateForwardFromPort}
                    killing={killProcessMutation.isPending}
                  />
                ))
              )}
            </div>
          </TabsContent>

          <TabsContent value="forwards" className="flex-1 overflow-hidden mt-0 px-0">
            <div className="h-full flex flex-col">
              <div className="shrink-0 px-3 sm:px-4 py-2 border-b border-ide-border">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={() => {
                    setAddError("");
                    setAddDialogOpen(true);
                  }}
                >
                  <Plus size={14} />
                  {t("plugin.portManager.addForward")}
                </Button>
              </div>

              <div className="flex-1 overflow-auto">
                {filteredForwards.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-32 text-ide-mute text-sm gap-2">
                    <ArrowRightLeft size={24} className="opacity-30" />
                    {t("plugin.portManager.noForwards")}
                  </div>
                ) : (
                  filteredForwards.map((fwd: ForwardRule) => (
                    <div
                      key={fwd.id}
                      className="flex items-center gap-3 px-3 sm:px-4 py-3 border-b border-ide-border hover:bg-ide-panel/50 transition-colors"
                    >
                      <div
                        className={`w-2 h-2 rounded-full shrink-0 ${fwd.enabled ? "bg-green-500" : "bg-gray-400"}`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono font-semibold text-sm text-ide-text">:{fwd.listenPort}</span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getProtocolColor(fwd.protocol)}`}
                          >
                            {fwd.protocol.toUpperCase()}
                          </span>
                          <ArrowRightLeft size={12} className="text-ide-mute" />
                          <span className="font-mono text-xs text-ide-mute truncate">{fwd.targetAddr}</span>
                        </div>
                        {fwd.error && <div className="mt-1 text-[10px] text-red-500 truncate">{fwd.error}</div>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {fwd.protocol !== "udp" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 text-ide-mute hover:text-ide-text"
                            onClick={() => handleOpenForward(fwd)}
                            disabled={!fwd.enabled}
                            title={t("plugin.portManager.openInBrowser")}
                          >
                            <ExternalLink size={14} />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className={`h-7 w-7 p-0 ${fwd.enabled ? "text-green-500 hover:text-orange-500" : "text-gray-400 hover:text-green-500"}`}
                          onClick={() => handleToggleForward(fwd.id, !fwd.enabled)}
                          disabled={toggleForwardMutation.isPending}
                        >
                          {fwd.enabled ? <Power size={14} /> : <PowerOff size={14} />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-500/10"
                          onClick={() => {
                            setRemoveTarget(fwd);
                            setRemoveDialogOpen(true);
                          }}
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>

      <AlertDialog
        open={addDialogOpen}
        onOpenChange={(open) => {
          setAddDialogOpen(open);
          if (!open) setAddError("");
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ArrowRightLeft size={18} className="text-ide-accent" />
              {t("plugin.portManager.addForwardTitle")}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <label className="text-xs text-ide-mute">{t("plugin.portManager.protocol")}</label>
              <Select
                value={newProtocol}
                onValueChange={(v) => {
                  setNewProtocol(v);
                  setAddError("");
                }}
              >
                <SelectTrigger className="h-8 text-sm bg-ide-panel border-ide-border">
                  <SelectValue placeholder={t("plugin.portManager.selectProtocol")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tcp">{t("plugin.portManager.tcp")}</SelectItem>
                  <SelectItem value="udp">{t("plugin.portManager.udp")}</SelectItem>
                  <SelectItem value="http">{t("plugin.portManager.http")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-ide-mute">{t("plugin.portManager.listenPort")}</label>
              <Input
                type="number"
                placeholder={t("plugin.portManager.listenPortPlaceholder")}
                value={newListenPort}
                onChange={(e) => {
                  setNewListenPort(e.target.value);
                  setAddError("");
                }}
                className="h-8 text-sm bg-ide-panel border-ide-border"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-ide-mute">{t("plugin.portManager.targetAddr")}</label>
              <Input
                placeholder={newProtocol === "http" ? "http://localhost:8080" : "localhost:8080"}
                value={newTargetAddr}
                onChange={(e) => {
                  setNewTargetAddr(e.target.value);
                  setAddError("");
                }}
                className="h-8 text-sm bg-ide-panel border-ide-border"
              />
              <p className="text-[10px] text-ide-mute">
                {newProtocol === "http" ? t("plugin.portManager.httpHint") : t("plugin.portManager.tcpHint")}
              </p>
            </div>
            {addError && <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-md">{addError}</div>}
          </div>
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <AlertDialogCancel className="text-sm">{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleAddForward}
              disabled={!newListenPort || !newTargetAddr || addForwardMutation.isPending}
              className="text-sm"
            >
              {addForwardMutation.isPending ? t("plugin.portManager.creating") : t("plugin.portManager.create")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("plugin.portManager.removeConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("plugin.portManager.removeConfirmDesc")}
              {removeTarget && (
                <span className="block mt-2 font-mono text-sm">
                  :{removeTarget.listenPort} → {removeTarget.targetAddr}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <AlertDialogCancel className="text-sm">{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveForward}
              variant="destructive"
              disabled={removeForwardMutation.isPending}
              className="text-sm"
            >
              {t("plugin.portManager.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={killDialogOpen} onOpenChange={setKillDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("plugin.portManager.killConfirm")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("plugin.portManager.killConfirmDesc")}
              <span className="block mt-2 font-mono text-sm">PID: {killTarget}</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <AlertDialogCancel className="text-sm">{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleKillProcess}
              variant="destructive"
              disabled={killProcessMutation.isPending}
              className="text-sm"
            >
              {t("plugin.portManager.killProcess")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

registerPage({
  id: "port-manager",
  name: "Port Manager",
  nameKey: "plugin.portManager.name",
  descriptionKey: "plugin.portManager.description",
  icon: Network,
  order: 12,
  category: "tool",
  singleton: true,
  View: PortManagerView,
});

export default PortManagerView;
