import { randomUUID } from "node:crypto";
import { eq, desc } from "drizzle-orm";

import type { TemplateType } from "@neuroclaw/shared";
import { type Database, memoryRecords } from "@neuroclaw/db";

export type MemoryRecordType =
  | "user_preference"
  | "brand_voice"
  | "successful_output"
  | "failed_output"
  | "channel_rule";

export interface MemoryRecord {
  id: string;
  workspaceId: string;
  templateType: TemplateType;
  type: MemoryRecordType;
  summary: string;
  sourceRunId: string;
  isPinned: boolean;
  isSuppressed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateMemoryRecordInput {
  summary?: string;
  isPinned?: boolean;
  isSuppressed?: boolean;
}

export interface MemoryStore {
  addRecord(record: MemoryRecord): Promise<MemoryRecord>;
  listByWorkspace(workspaceId: string): Promise<MemoryRecord[]>;
  getById(memoryId: string): Promise<MemoryRecord | undefined>;
  updateRecord(memoryId: string, input: UpdateMemoryRecordInput): Promise<MemoryRecord>;
  deleteRecord(memoryId: string): Promise<void>;
}

type MemoryRow = typeof memoryRecords.$inferSelect;
type MemoryInsert = typeof memoryRecords.$inferInsert;

function rowToRecord(row: MemoryRow): MemoryRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    templateType: row.templateType as TemplateType,
    type: row.type as MemoryRecordType,
    summary: row.summary,
    sourceRunId: row.sourceRunId,
    isPinned: row.isPinned,
    isSuppressed: row.isSuppressed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

export class DrizzleMemoryStore implements MemoryStore {
  constructor(private readonly db: Database) {}

  async addRecord(record: MemoryRecord): Promise<MemoryRecord> {
    const row: MemoryInsert = {
      id: record.id,
      workspaceId: record.workspaceId,
      templateType: record.templateType,
      type: record.type,
      summary: record.summary,
      sourceRunId: record.sourceRunId,
      isPinned: record.isPinned,
      isSuppressed: record.isSuppressed,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
    await this.db.insert(memoryRecords).values(row);
    return record;
  }

  async listByWorkspace(workspaceId: string): Promise<MemoryRecord[]> {
    const rows = await this.db.select().from(memoryRecords)
      .where(eq(memoryRecords.workspaceId, workspaceId))
      .orderBy(desc(memoryRecords.updatedAt));
    return rows.map(rowToRecord);
  }

  async getById(memoryId: string): Promise<MemoryRecord | undefined> {
    const rows = await this.db.select().from(memoryRecords)
      .where(eq(memoryRecords.id, memoryId));
    return rows.length > 0 ? rowToRecord(rows[0]) : undefined;
  }

  async updateRecord(memoryId: string, input: UpdateMemoryRecordInput): Promise<MemoryRecord> {
    const existing = await this.getById(memoryId);
    if (!existing) {
      throw new Error(`Memory record not found: ${memoryId}`);
    }

    const updates: Partial<MemoryInsert> = {
      updatedAt: new Date().toISOString()
    };

    if (input.summary !== undefined) {
      updates.summary = input.summary;
    }

    if (input.isPinned !== undefined) {
      updates.isPinned = input.isPinned;
    }

    if (input.isSuppressed !== undefined) {
      updates.isSuppressed = input.isSuppressed;
    }

    await this.db.update(memoryRecords).set(updates).where(eq(memoryRecords.id, memoryId));
    return { ...existing, ...input, updatedAt: updates.updatedAt! };
  }

  async deleteRecord(memoryId: string): Promise<void> {
    const existing = await this.getById(memoryId);
    if (!existing) {
      throw new Error(`Memory record not found: ${memoryId}`);
    }
    await this.db.delete(memoryRecords).where(eq(memoryRecords.id, memoryId));
  }
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly records: MemoryRecord[] = [];

  async addRecord(record: MemoryRecord): Promise<MemoryRecord> {
    this.records.push(record);
    return record;
  }

  async listByWorkspace(workspaceId: string): Promise<MemoryRecord[]> {
    return this.records
      .filter((record) => record.workspaceId === workspaceId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getById(memoryId: string): Promise<MemoryRecord | undefined> {
    return this.records.find((record) => record.id === memoryId);
  }

  async updateRecord(memoryId: string, input: UpdateMemoryRecordInput): Promise<MemoryRecord> {
    const record = this.records.find((r) => r.id === memoryId);
    if (!record) {
      throw new Error(`Memory record not found: ${memoryId}`);
    }

    if (input.summary !== undefined) {
      record.summary = input.summary;
    }

    if (input.isPinned !== undefined) {
      record.isPinned = input.isPinned;
    }

    if (input.isSuppressed !== undefined) {
      record.isSuppressed = input.isSuppressed;
    }

    record.updatedAt = new Date().toISOString();
    return record;
  }

  async deleteRecord(memoryId: string): Promise<void> {
    const index = this.records.findIndex((record) => record.id === memoryId);
    if (index === -1) {
      throw new Error(`Memory record not found: ${memoryId}`);
    }

    this.records.splice(index, 1);
  }
}
