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
import React, { useCallback, useId, useMemo, useState } from "react";
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
        className="flex min-h-11 w-full min-w-0 cursor-pointer items-center px-3 py-2.5 text-left transition-colors hover:bg-ide-panel/50 md:min-h-0 md:px-4 md:py-2"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <div className="flex w-5 shrink-0 items-center">
          {expanded ? (
            <ChevronDown size={14} className="text-ide-mute" />
          ) : (
            <ChevronRight size={14} className="text-ide-mute" />
          )}
        </div>
        <div className="w-16 shrink-0 md:w-20">
          <span className="font-mono font-semibold text-sm text-ide-text">{port.port}</span>
        </div>
        <div className="w-14 shrink-0 md:w-16">
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${getProtocolColor(port.protocol)}`}>
            {port.protocol.toUpperCase()}
          </span>
        </div>
        <div className="hidden min-w-0 flex-1 truncate font-mono text-xs text-ide-mute md:block">{port.localAddr}</div>
        <div className="hidden w-16 shrink-0 md:block">
          {port.status && (
            <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-500/15 text-green-500">
              {t("plugin.portManager.listening")}
            </span>
          )}
        </div>
        <div className="hidden w-16 shrink-0 font-mono text-xs text-ide-mute md:block">
          {port.pid > 0 ? port.pid : "-"}
        </div>
        <div className="flex min-w-0 flex-1 shrink-0 items-center text-xs text-ide-text md:flex-none md:w-32">
          <span className="min-w-0 truncate">{port.processName || "-"}</span>
          {port.pid > 0 && <span className="ml-1 shrink-0 text-ide-mute md:hidden">({port.pid})</span>}
        </div>
      </button>

      {expanded && (
        <div className="min-w-0 bg-ide-panel/30 px-3 pb-3 pt-1 md:px-4">
          <div className="mb-3 grid min-w-0 grid-cols-2 gap-x-4 gap-y-2 text-xs md:grid-cols-4">
            <div className="min-w-0">
              <span className="text-ide-mute block">{t("plugin.portManager.port")}</span>
              <span className="text-ide-text font-mono font-semibold">{port.port}</span>
            </div>
            <div className="min-w-0">
              <span className="text-ide-mute block">{t("plugin.portManager.protocol")}</span>
              <span className="text-ide-text font-mono">{port.protocol.toUpperCase()}</span>
            </div>
            <div className="min-w-0">
              <span className="text-ide-mute block">{t("plugin.portManager.localAddr")}</span>
              <span className="break-all font-mono text-ide-text md:break-normal">{port.localAddr}</span>
            </div>
            <div className="min-w-0">
              <span className="text-ide-mute block">{t("plugin.portManager.status")}</span>
              <span className="text-green-500">{port.status || "-"}</span>
            </div>
            <div className="min-w-0">
              <span className="text-ide-mute block">{t("plugin.portManager.pid")}</span>
              <span className="text-ide-text font-mono">{port.pid > 0 ? port.pid : "-"}</span>
            </div>
            <div className="min-w-0">
              <span className="text-ide-mute block">{t("plugin.portManager.processName")}</span>
              <span className="break-words text-ide-text md:break-normal">{port.processName || "-"}</span>
            </div>
          </div>

          <div className="flex flex-col items-stretch gap-2 md:flex-row md:flex-wrap md:items-center">
            {port.protocol === "tcp" && (
              <Button
                variant="outline"
                size="sm"
                className="h-11 w-full gap-1 text-xs md:h-7 md:w-auto"
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
              className="h-11 w-full gap-1 text-xs md:h-7 md:w-auto"
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
                className="h-11 w-full gap-1 border-red-500/30 text-xs text-red-500 hover:bg-red-500/10 hover:text-red-600 md:h-7 md:w-auto"
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
  const fieldId = useId();
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
          <div className="relative min-w-0 flex-1 md:flex-none">
            <Search
              size={14}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-ide-mute sm:w-4 sm:h-4 sm:left-2.5"
            />
            <Input
              id={`${fieldId}-search`}
              name="port-search"
              aria-label={t("plugin.portManager.search")}
              placeholder={t("plugin.portManager.search")}
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="h-11 w-full border-ide-border bg-ide-panel pl-7 text-base md:h-8 md:w-48 md:pl-8 md:text-sm"
            />
          </div>
          <Select value={refreshInterval.toString()} onValueChange={(v) => setRefreshInterval(Number(v))}>
            <SelectTrigger
              aria-label={t("plugin.portManager.refresh")}
              className="h-11 min-h-11 w-20 shrink-0 border-ide-border bg-ide-panel px-2 text-xs md:h-8 md:min-h-0 md:px-3 md:text-sm"
            >
              <Timer size={12} className="hidden md:block md:size-3.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {refreshOptions.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="min-h-11 md:min-h-0">
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
            <TabsList className="min-h-11 md:min-h-9">
              <TabsTrigger value="ports" className="min-h-11 gap-1 px-3 text-xs md:min-h-0 md:px-2">
                <Network size={14} />
                {t("plugin.portManager.ports")}
                {portData?.ports && (
                  <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-ide-border">
                    {portData.ports.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="forwards" className="min-h-11 gap-1 px-3 text-xs md:min-h-0 md:px-2">
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
              <div className="sticky top-0 z-10 hidden items-center border-b border-ide-border bg-ide-bg px-3 py-2 text-xs font-medium text-ide-mute md:flex md:px-4">
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
                  className="h-11 gap-1 text-xs md:h-7"
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
                      className="flex min-w-0 items-center gap-2 border-b border-ide-border px-3 py-3 transition-colors hover:bg-ide-panel/50 md:gap-3 md:px-4"
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
                          <span className="min-w-0 max-w-full truncate font-mono text-xs text-ide-mute">
                            {fwd.targetAddr}
                          </span>
                        </div>
                        {fwd.error && <div className="mt-1 text-[10px] text-red-500 truncate">{fwd.error}</div>}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {fwd.protocol !== "udp" && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-11 p-0 text-ide-mute hover:text-ide-text md:size-7"
                            onClick={() => handleOpenForward(fwd)}
                            disabled={!fwd.enabled}
                            title={t("plugin.portManager.openInBrowser")}
                            aria-label={t("plugin.portManager.openInBrowser")}
                          >
                            <ExternalLink size={14} />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className={`size-11 p-0 md:size-7 ${fwd.enabled ? "text-green-500 hover:text-orange-500" : "text-gray-400 hover:text-green-500"}`}
                          onClick={() => handleToggleForward(fwd.id, !fwd.enabled)}
                          disabled={toggleForwardMutation.isPending}
                          aria-label={t(fwd.enabled ? "plugin.portManager.disable" : "plugin.portManager.enable")}
                          title={t(fwd.enabled ? "plugin.portManager.disable" : "plugin.portManager.enable")}
                        >
                          {fwd.enabled ? <Power size={14} /> : <PowerOff size={14} />}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-11 p-0 text-red-500 hover:bg-red-500/10 hover:text-red-600 md:size-7"
                          onClick={() => {
                            setRemoveTarget(fwd);
                            setRemoveDialogOpen(true);
                          }}
                          aria-label={t("plugin.portManager.remove")}
                          title={t("plugin.portManager.remove")}
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
              <label htmlFor={`${fieldId}-protocol`} className="text-xs text-ide-mute">
                {t("plugin.portManager.protocol")}
              </label>
              <Select
                value={newProtocol}
                onValueChange={(v) => {
                  setNewProtocol(v);
                  setAddError("");
                }}
              >
                <SelectTrigger
                  id={`${fieldId}-protocol`}
                  aria-label={t("plugin.portManager.protocol")}
                  className="h-11 min-h-11 border-ide-border bg-ide-panel text-sm md:h-8 md:min-h-0"
                >
                  <SelectValue placeholder={t("plugin.portManager.selectProtocol")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="tcp" className="min-h-11 md:min-h-0">
                    {t("plugin.portManager.tcp")}
                  </SelectItem>
                  <SelectItem value="udp" className="min-h-11 md:min-h-0">
                    {t("plugin.portManager.udp")}
                  </SelectItem>
                  <SelectItem value="http" className="min-h-11 md:min-h-0">
                    {t("plugin.portManager.http")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${fieldId}-listen-port`} className="text-xs text-ide-mute">
                {t("plugin.portManager.listenPort")}
              </label>
              <Input
                id={`${fieldId}-listen-port`}
                name="listen-port"
                aria-label={t("plugin.portManager.listenPort")}
                type="number"
                placeholder={t("plugin.portManager.listenPortPlaceholder")}
                value={newListenPort}
                onChange={(e) => {
                  setNewListenPort(e.target.value);
                  setAddError("");
                }}
                className="h-11 border-ide-border bg-ide-panel text-base md:h-8 md:text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${fieldId}-target-address`} className="text-xs text-ide-mute">
                {t("plugin.portManager.targetAddr")}
              </label>
              <Input
                id={`${fieldId}-target-address`}
                name="target-address"
                aria-label={t("plugin.portManager.targetAddr")}
                placeholder={newProtocol === "http" ? "http://localhost:8080" : "localhost:8080"}
                value={newTargetAddr}
                onChange={(e) => {
                  setNewTargetAddr(e.target.value);
                  setAddError("");
                }}
                className="h-11 border-ide-border bg-ide-panel text-base md:h-8 md:text-sm"
              />
              <p className="text-[10px] text-ide-mute">
                {newProtocol === "http" ? t("plugin.portManager.httpHint") : t("plugin.portManager.tcpHint")}
              </p>
            </div>
            {addError && <div className="text-xs text-red-500 bg-red-500/10 px-3 py-2 rounded-md">{addError}</div>}
          </div>
          <AlertDialogFooter className="gap-2 sm:gap-0">
            <AlertDialogCancel className="min-h-11 text-sm md:min-h-0">{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleAddForward}
              disabled={!newListenPort || !newTargetAddr || addForwardMutation.isPending}
              className="min-h-11 text-sm md:min-h-0"
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
            <AlertDialogCancel className="min-h-11 text-sm md:min-h-0">{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemoveForward}
              variant="destructive"
              disabled={removeForwardMutation.isPending}
              className="min-h-11 text-sm md:min-h-0"
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
            <AlertDialogCancel className="min-h-11 text-sm md:min-h-0">{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleKillProcess}
              variant="destructive"
              disabled={killProcessMutation.isPending}
              className="min-h-11 text-sm md:min-h-0"
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
