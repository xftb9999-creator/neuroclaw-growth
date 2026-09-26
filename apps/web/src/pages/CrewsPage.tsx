import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  addCrewMember,
  createCrewTeam,
  getBenchmarks,
  getCrewTeamDetail,
  getTeamMemory,
  getWorkspaceIndustry,
  listAgents,
  listCrewTeams,
  removeCrewMember,
  setWorkspaceIndustry,
  updateCrewTeamStatus,
  type AgentRecord,
  type BenchmarkEntry,
  type CrewTeam
} from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Input, Skeleton } from "../components/ui/Input.js";
import { EmptyState, ErrorBanner, InfoBanner, RouteLayout } from "../components/Layout.js";
import { navigate } from "../lib/router.js";

const POSITIONS = ["content", "conversion", "review", "operator"] as const;

export function CrewsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const crewsQuery = useQuery({
    queryKey: ["crews"],
    queryFn: () => listCrewTeams(readWs()) as Promise<CrewTeam[]>
  });

  const detailQuery = useQuery({
    queryKey: ["crew-detail", selectedId],
    queryFn: () => getCrewTeamDetail(selectedId!),
    enabled: Boolean(selectedId)
  });

  const memoryQuery = useQuery({
    queryKey: ["crew-memory", selectedId],
    queryFn: () => getTeamMemory(selectedId!),
    enabled: Boolean(selectedId)
  });

  const agentsQuery = useQuery({
    queryKey: ["agents"],
    queryFn: () => listAgents() as Promise<AgentRecord[]>
  });

  useEffect(() => {
    if (crewsQuery.error) {
      setError(crewsQuery.error instanceof Error ? crewsQuery.error.message : t("history.loadError"));
    }
  }, [crewsQuery.error, t]);

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["crews"] });
    if (selectedId) {
      void queryClient.invalidateQueries({ queryKey: ["crew-detail", selectedId] });
      void queryClient.invalidateQueries({ queryKey: ["crew-memory", selectedId] });
    }
  };

  const onCreate = async () => {
    if (!name.trim()) return;
    setCreating(true);
    try {
      await createCrewTeam({ workspaceId: readWs()!, name: name.trim(), goal: goal.trim() || undefined });
      setNotice(t("crews.created"));
      setError(null);
      setName("");
      setGoal("");
      void queryClient.invalidateQueries({ queryKey: ["crews"] });
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t("history.loadError"));
    } finally {
      setCreating(false);
    }
  };

  const changeStatus = async (teamId: string, status: string) => {
    try {
      await updateCrewTeamStatus(teamId, status);
      refreshAll();
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : t("history.loadError"));
    }
  };

  const crews = crewsQuery.data ?? [];
  const detail = detailQuery.data ?? null;
  const memory = memoryQuery.data ?? null;
  const agents = agentsQuery.data ?? [];

  return (
    <RouteLayout title={t("crews.title")} subtitle={t("crews.subtitle")}>
      <ErrorBanner error={error} />
      <InfoBanner message={notice} />

      <IndustryBenchmarkCard />

      <div className="grid lg:grid-cols-[1fr_1.4fr] gap-4 items-start">
        {/* 建团 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-[15.5px]">{t("crews.create")}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <label className="grid gap-1">
              <span className="text-[12.5px] text-muted">{t("crews.nameLabel")}</span>
              <Input
                data-testid="crew-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("crews.namePlaceholder")}
              />
            </label>
            <label className="grid gap-1">
              <span className="text-[12.5px] text-muted">{t("crews.goalLabel")}</span>
              <Input
                data-testid="crew-goal"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder={t("crews.goalPlaceholder")}
              />
            </label>
            <Button data-testid="crew-create" disabled={creating || !name.trim()} onClick={() => void onCreate()}>
              {creating ? t("common.loading") : t("crews.create")}
            </Button>
          </CardContent>
        </Card>

        {/* 列表 */}
        <div className="grid gap-3">
          {crewsQuery.isPending ? (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : crews.length === 0 ? (
            <EmptyState title={t("crews.emptyTitle")} body={t("crews.emptyBody")} />
          ) : (
            crews.map((crew) => (
              <Card
                key={crew.id}
                data-testid={`crew-${crew.name}`}
                className={`cursor-pointer ${selectedId === crew.id ? "ring-1 ring-brand/40" : ""}`}
                onClick={() => setSelectedId(crew.id)}
              >
                <CardContent className="flex items-center gap-2 flex-wrap py-3">
                  <strong>{crew.name}</strong>
                  <Badge variant={crew.status === "active" ? "completed" : crew.status === "paused" ? "waiting" : "default"}>
                    {crew.status}
                  </Badge>
                  <span className="text-muted text-[12px] ml-auto">
                    {(crew.members?.length ?? 0)} · {t("crews.membersCount")}
                  </span>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>

      {/* 详情：编制 + 团队记忆 */}
      {detail && (
        <div className="grid gap-4 lg:grid-cols-2 mt-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-[15.5px]">{detail.name}</CardTitle>
              <div className="flex gap-1.5 flex-wrap">
                {detail.status === "active" && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => void changeStatus(detail.id, "paused")}>
                      {t("crews.pause")}
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => void changeStatus(detail.id, "archived")}>
                      {t("crews.archive")}
                    </Button>
                  </>
                )}
                {detail.status !== "archived" && detail.status !== "active" && (
                  <Button size="sm" variant="secondary" onClick={() => void changeStatus(detail.id, "active")}>
                    {t("crews.resume")}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              <p className="m-0 text-[13px] text-muted">{detail.goal}</p>
              <div className="grid gap-2">
                {(detail.members ?? []).map((member) => (
                  <div key={member.id} className="flex items-center gap-2 rounded-input border hairline p-2.5">
                    <Badge variant="default">{member.position}</Badge>
                    <AgentName agentId={member.agentId} agents={agents} />
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      onClick={() => {
                        void removeCrewMember(detail.id, member.id).then(refreshAll);
                      }}
                    >
                      ✕
                    </Button>
                  </div>
                ))}
              </div>
              <AddMemberForm teamId={detail.id} agents={agents} onDone={refreshAll} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-[15.5px]">{t("crews.memoryTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {memoryQuery.isPending ? (
                <Skeleton className="h-20 w-full" />
              ) : (memory?.memories.length ?? 0) === 0 ? (
                <p className="m-0 text-sm text-muted">{t("crews.memoryEmpty")}</p>
              ) : (
                <div data-testid="crew-memory-list" className="grid gap-2">
                  {memory!.memories.map((entry) => (
                    <div key={entry.id} className="rounded-input border hairline p-2.5 grid gap-0.5">
                      <span className="text-[13.5px] leading-snug">{entry.summary}</span>
                      <span className="text-[11.5px] text-muted">
                        {new Date(entry.updatedAt).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* 发起接力入口 */}
      {selectedId && detail && (
        <Button onClick={() => navigate("/team")}>{t("crews.launchRelay")}</Button>
      )}
    </RouteLayout>
  );
}

function IndustryBenchmarkCard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [industryDraft, setIndustryDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const workspaceId = readWs();

  const industryQuery = useQuery({
    queryKey: ["workspace-industry", workspaceId],
    queryFn: () => getWorkspaceIndustry(workspaceId),
    enabled: Boolean(workspaceId)
  });

  const industry = industryQuery.data?.industry ?? null;

  const benchmarksQuery = useQuery({
    queryKey: ["benchmarks", industry],
    queryFn: () => getBenchmarks(industry!),
    enabled: Boolean(industry)
  });

  const benchmarks: BenchmarkEntry[] = benchmarksQuery.data ?? [];

  const onSave = async () => {
    if (!workspaceId || !industryDraft.trim()) return;
    setSaving(true);
    try {
      await setWorkspaceIndustry(workspaceId, industryDraft.trim());
      await queryClient.invalidateQueries({ queryKey: ["workspace-industry", workspaceId] });
      await queryClient.invalidateQueries({ queryKey: ["benchmarks"] });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="bench-card">
      <CardHeader>
        <CardTitle className="text-[15.5px]">
          {t("bench.title")}
          {industry && <Badge variant="default">{industry}</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {!industry ? (
          <>
            <p className="m-0 text-[13px] text-muted">{t("bench.none")}</p>
            <div className="flex gap-2 flex-wrap items-center">
              <Input
                data-testid="bench-industry-input"
                value={industryDraft}
                onChange={(event) => setIndustryDraft(event.target.value)}
                placeholder={t("bench.industryPlaceholder")}
              />
              <Button
                size="sm"
                variant="secondary"
                data-testid="bench-industry-save"
                disabled={saving || !industryDraft.trim()}
                onClick={() => void onSave()}
              >
                {t("bench.save")}
              </Button>
            </div>
          </>
        ) : benchmarksQuery.isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : benchmarks.length === 0 ? (
          <p className="m-0 text-sm text-muted" data-testid="bench-empty">{t("bench.empty")}</p>
        ) : (
          <div className="grid gap-2" data-testid="bench-rows">
            {benchmarks.map((entry) => (
              <div key={`${entry.templateType}-${entry.period}`} className="flex items-center gap-2 flex-wrap rounded-input border hairline p-2.5">
                <Badge variant="default">{entry.templateType}</Badge>
                <span className="text-[13px]">
                  {t("bench.success")}: {entry.successRate === null ? "n/a" : `${Math.round(entry.successRate * 100)}%`}
                </span>
                <span className="text-[13px] text-muted">
                  {t("bench.p50")}: {entry.p50DurationSec === null ? "n/a" : `${Math.round(entry.p50DurationSec)}s`}
                  {" · "}
                  {t("bench.p90")}: {entry.p90DurationSec === null ? "n/a" : `${Math.round(entry.p90DurationSec)}s`}
                </span>
                <span className="text-[12px] text-muted ml-auto">n={entry.sampleSize}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AgentName(props: { agentId: string; agents: AgentRecord[] }) {
  const agent = props.agents.find((a) => a.id === props.agentId);
  return <span className="text-[14px] font-medium">{agent ? agent.name : props.agentId.slice(0, 10)}</span>;
}

function AddMemberForm(props: {
  teamId: string;
  agents: AgentRecord[];
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [agentId, setAgentId] = useState("");
  const [position, setPosition] = useState<string>("content");
  const [busy, setBusy] = useState(false);

  if (props.agents.length === 0) {
    return <p className="m-0 text-[12.5px] text-muted">{t("crews.noAgents")}</p>;
  }

  return (
    <div className="flex gap-2 flex-wrap items-center">
      <select
        data-testid="crew-agent-select"
        value={agentId}
        onChange={(e) => setAgentId(e.target.value)}
        className="border border-line rounded-input px-3 py-2 text-[14px] bg-white"
        aria-label={t("crews.agentSelect")}
      >
        <option value="">{t("crews.agentSelect")}</option>
        {props.agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.name}
          </option>
        ))}
      </select>
      <select
        data-testid="crew-position-select"
        value={position}
        onChange={(e) => setPosition(e.target.value)}
        className="border border-line rounded-input px-3 py-2 text-[14px] bg-white"
        aria-label={t("crews.positionLabel")}
      >
        {POSITIONS.map((position) => (
          <option key={position} value={position}>
            {position}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="secondary"
        disabled={!agentId || busy}
        onClick={() => {
          setBusy(true);
          addCrewMember(props.teamId, { agentId, position })
            .then(() => {
              setAgentId("");
              props.onDone();
            })
            .finally(() => setBusy(false));
        }}
      >
        ＋ {t("crews.addMember")}
      </Button>
    </div>
  );
}

function readWs(): string {
  try {
    return window.localStorage.getItem("neuroclaw.workspaceId") ?? "";
  } catch {
    return "";
  }
}
