import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface SseServerConfig {
  type: "sse";
  url: string;
}

export interface HttpServerConfig {
  type: "http";
  url: string;
}

export type McpServerConfig = StdioServerConfig | SseServerConfig | HttpServerConfig;

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError: boolean;
  raw: unknown;
}

export interface McpConnectionStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  lastError?: string;
}

// ---------------------------------------------------------------------------
// McpConnection — single MCP server connection
// ---------------------------------------------------------------------------

export class McpConnection {
  private client: Client | null = null;
  private transport: InstanceType<typeof StdioClientTransport> | InstanceType<typeof SSEClientTransport> | InstanceType<typeof StreamableHTTPClientTransport> | null = null;
  private toolsCache: McpToolInfo[] = [];
  private connected = false;
  private lastError: string | undefined;

  constructor(
    public readonly name: string,
    private readonly config: McpServerConfig
  ) {}

  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      if (this.config.type === "stdio") {
        this.transport = new StdioClientTransport({
          command: this.config.command,
          args: this.config.args ?? [],
          env: this.config.env ? { ...process.env, ...this.config.env } as Record<string, string> : undefined
        });
      } else if (this.config.type === "sse") {
        this.transport = new SSEClientTransport(new URL(this.config.url));
      } else {
        this.transport = new StreamableHTTPClientTransport(new URL(this.config.url));
      }

      this.client = new Client(
        { name: "neuroclaw-runtime", version: "0.1.0" },
        { capabilities: {} }
      );

      await this.client.connect(this.transport);
      this.connected = true;
      this.lastError = undefined;

      // Eagerly discover tools
      await this.refreshTools();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.connected = false;
      throw new Error(`MCP connect failed for '${this.name}': ${this.lastError}`);
    }
  }

  async refreshTools(): Promise<McpToolInfo[]> {
    if (!this.client || !this.connected) return [];

    try {
      const result = await this.client.listTools();
      this.toolsCache = (result.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>
      }));
      return this.toolsCache;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return [];
    }
  }

  listTools(): McpToolInfo[] {
    return this.toolsCache;
  }

  hasTool(toolName: string): boolean {
    return this.toolsCache.some((t) => t.name === toolName);
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<McpToolCallResult> {
    if (!this.client || !this.connected) {
      throw new Error(`MCP connection '${this.name}' is not connected`);
    }

    const result = await this.client.callTool({
      name: toolName,
      arguments: args
    });

    const rawResult = result as {
      content?: Array<Record<string, unknown>>;
      isError?: boolean;
    };

    return {
      content: (rawResult.content ?? []).map((c) => ({
        type: String(c.type ?? "text"),
        text: typeof c.text === "string" ? c.text : undefined,
        data: typeof c.data === "string" ? c.data : undefined,
        mimeType: typeof c.mimeType === "string" ? c.mimeType : undefined
      })),
      isError: rawResult.isError ?? false,
      raw: result
    };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.toolsCache = [];

    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // ignore
      }
      this.client = null;
    }
    this.transport = null;
  }

  getStatus(): McpConnectionStatus {
    return {
      name: this.name,
      connected: this.connected,
      toolCount: this.toolsCache.length,
      lastError: this.lastError
    };
  }
}

// ---------------------------------------------------------------------------
// McpRegistry — manages multiple MCP server connections
// ---------------------------------------------------------------------------

export class McpRegistry {
  private readonly connections = new Map<string, McpConnection>();

  register(name: string, config: McpServerConfig): McpConnection {
    const existing = this.connections.get(name);
    if (existing) {
      return existing;
    }
    const conn = new McpConnection(name, config);
    this.connections.set(name, conn);
    return conn;
  }

  get(name: string): McpConnection | undefined {
    return this.connections.get(name);
  }

  async connectAll(): Promise<{ ok: string[]; failed: string[] }> {
    const ok: string[] = [];
    const failed: string[] = [];

    for (const [name, conn] of this.connections) {
      try {
        await conn.connect();
        ok.push(name);
      } catch {
        failed.push(name);
      }
    }

    return { ok, failed };
  }

  listAllTools(): Array<{ connection: string; tool: McpToolInfo }> {
    const all: Array<{ connection: string; tool: McpToolInfo }> = [];
    for (const [name, conn] of this.connections) {
      for (const tool of conn.listTools()) {
        all.push({ connection: name, tool });
      }
    }
    return all;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<{ result: McpToolCallResult; connection: string }> {
    for (const [name, conn] of this.connections) {
      if (conn.hasTool(toolName)) {
        const result = await conn.callTool(toolName, args);
        return { result, connection: name };
      }
    }
    throw new Error(`No MCP connection provides tool '${toolName}'`);
  }

  getStatuses(): McpConnectionStatus[] {
    return Array.from(this.connections.values()).map((c) => c.getStatus());
  }

  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.connections.values()).map((c) => c.disconnect());
    await Promise.allSettled(promises);
    this.connections.clear();
  }
}

// ---------------------------------------------------------------------------
// Factory + config parsing
// ---------------------------------------------------------------------------

let registrySingleton: McpRegistry | null = null;

export function getMcpRegistry(): McpRegistry {
  if (!registrySingleton) {
    registrySingleton = new McpRegistry();
    loadFromEnv(registrySingleton);
  }
  return registrySingleton;
}

export function resetMcpRegistry(): void {
  registrySingleton = null;
}

function loadFromEnv(registry: McpRegistry): void {
  const raw = process.env.NEUROCLAW_MCP_SERVERS;
  if (!raw) return;

  try {
    const configs = JSON.parse(raw) as Array<{
      name: string;
      type: "stdio" | "sse" | "http";
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
    }>;

    for (const cfg of configs) {
      if (cfg.type === "stdio" && cfg.command) {
        registry.register(cfg.name, {
          type: "stdio",
          command: cfg.command,
          args: cfg.args,
          env: cfg.env
        });
      } else if (cfg.type === "sse" && cfg.url) {
        registry.register(cfg.name, { type: "sse", url: cfg.url });
      } else if (cfg.type === "http" && cfg.url) {
        registry.register(cfg.name, { type: "http", url: cfg.url });
      }
    }
  } catch {
    // invalid config, skip
  }
}

export function isMcpAvailable(): boolean {
  return Boolean(process.env.NEUROCLAW_MCP_SERVERS);
}
