import { useEffect, useState } from "react";

import {
  fetchMcpStatus,
  listAgents,
  listTemplates,
  updateAgentStatus,
  type AgentRecord,
  type McpStatusResponse
} from "../lib/api.js";
import { navigate } from "../lib/router.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout } from "../components/Layout.js";

interface TemplateLike {
  id: string;
  type: string;
  name: string;
  description?: string;
}

export function AgentsSquarePage() {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [templates, setTemplates] = useState<TemplateLike[]>([]);
  const [mcp, setMcp] = useState<McpStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const [agentItems, templateItems, mcpStatus] = await Promise.all([
        listAgents(),
        listTemplates(),
        fetchMcpStatus().catch(() => null)
      ]);
      setAgents(agentItems as AgentRecord[]);
      setTemplates(templateItems as TemplateLike[]);
      setMcp(mcpStatus);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("history.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = async (agent: AgentRecord) => {
    await updateAgentStatus(agent.id, agent.status === "active" ? "inactive" : "active");
    await load();
  };

  const customBySlug = new Map(agents.map((agent) => [agent.slug, agent]));

  return (
    <RouteLayout title={t("agents.title")} subtitle={t("agents.subtitle")}>
      <ErrorBanner error={error} />

      <div className="flex items-center justify-between flex-wrap gap-2">
        <h3 className="m-0 text-lg font-bold tracking-tight">{t("agents.title")} · 智能体</h3>
        <Button onClick={() => navigate("/agents/new")}>{t("agents.create")}</Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {loading
          ? Array.from({ length: 3 }).map((_, index) => (
              <Card key={index}>
                <Skeleton className="h-24 w-full" />
              </Card>
            ))
          : templates.map((template) => {
              const isCustom = !template.id.startsWith("tpl_");
              const agent = customBySlug.get(template.type);
              return (
                <Card key={template.id} className="glass-hover lift grid gap-3">
                  <CardHeader>
                    <Badge variant={isCustom ? "default" : "info"}>
                      {isCustom ? t("agents.custom") : t("agents.builtin")}
                    </Badge>
                    {isCustom && agent && (
                      <Badge variant={agent.status === "active" ? "completed" : "failed"}>
                        {agent.status}
                      </Badge>
                    )}
                  </CardHeader>
                  <CardTitle className="text-[17px]">{template.name}</CardTitle>
                  <CardContent>
                    <p className="text-[13px] text-muted m-0 line-clamp-3">
                      {template.description ?? ""}
                    </p>
                    <div className="flex gap-2 mt-1">
                      <Button
                        size="sm"
                        onClick={() => navigate(`/launch?intent=${template.type}`)}
                      >
                        {t("agents.launch")}
                      </Button>
                      {isCustom && agent && (
                        <Button size="sm" variant="outline" onClick={() => void toggle(agent)}>
                          {agent.status === "active" ? t("agents.disable") : t("agents.enable")}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
      </div>

      {/* MCP 插件区 */}
      <section className="grid gap-3 mt-2">
        <h3 className="m-0 text-lg font-bold tracking-tight">{t("agents.mcpTitle")}</h3>
        {!mcp || (!mcp.available && mcp.servers.length === 0) ? (
          <Card className="p-5">
            <p className="m-0 text-muted text-sm">🔌 {t("agents.mcpEmpty")}</p>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {mcp.servers.map((server) => (
              <Card key={server.name} className="lift">
                <CardHeader>
                  <CardTitle className="text-[16px]">{server.name}</CardTitle>
                  <Badge variant={server.connected ? "completed" : "waiting"}>
                    {server.connected ? t("agents.connected") : t("agents.disconnected")}
                  </Badge>
                </CardHeader>
                <CardContent>
                  <span className="text-[13px] text-muted">
                    {t("agents.toolsCount")}: {server.toolCount}
                  </span>
                </CardContent>
              </Card>
            ))}
            {mcp.tools.length > 0 && (
              <Card className="md:col-span-2">
                <CardHeader>
                  <CardTitle className="text-[15px]">🧰 Tools</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-1.5">
                    {mcp.tools.map((tool) => (
                      <span
                        key={`${tool.connection}-${tool.name}`}
                        className="text-[12px] font-medium bg-surface-strong rounded-pill px-2.5 py-1"
                        title={tool.description}
                      >
                        {tool.connection} · {tool.name}
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </section>
    </RouteLayout>
  );
}
