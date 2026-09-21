import { randomUUID } from 'node:crypto';
import { BUNDLED_WORKFLOWS, FULL_SDLC_WORKFLOW, snapshotWorkflow, type Workflow, type WorkflowRecord } from '@sindral/shared';
import type { Repository } from '../db/repository.js';
import { conflict, notFound } from '../errors.js';

/** Strip record metadata so the result is a plain `Workflow` suitable for pinning. */
export function toWorkflow(record: WorkflowRecord): Workflow {
  const workflow: Workflow = { id: record.id, name: record.name, entryStepId: record.entryStepId, steps: record.steps, edges: record.edges };
  if (record.description !== undefined) workflow.description = record.description;
  if (record.troubleshootStep !== undefined) workflow.troubleshootStep = record.troubleshootStep;
  return snapshotWorkflow(workflow);
}

export class WorkflowService {
  /** Prevents two concurrent first requests from seeding twice within one process. */
  private readonly seeding = new Map<string, Promise<WorkflowRecord[]>>();

  constructor(private readonly repo: Repository) {}

  async list(userId: string): Promise<WorkflowRecord[]> {
    const existing = await this.repo.listWorkflows(userId);
    if (existing.length > 0) return existing;
    return this.seed(userId);
  }

  async get(userId: string, id: string): Promise<WorkflowRecord | null> {
    const record = await this.repo.getWorkflow(userId, id);
    if (record) return record;
    const all = await this.list(userId);
    return all.find((w) => w.id === id) ?? null;
  }

  async getDefault(userId: string): Promise<WorkflowRecord | null> {
    const all = await this.list(userId);
    return all.find((w) => w.isDefault) ?? all[0] ?? null;
  }

  async create(userId: string, name: string, cloneFrom?: string): Promise<WorkflowRecord> {
    const source = await this.resolveCloneSource(userId, cloneFrom);
    const id = randomUUID();
    const definition: Workflow = { ...snapshotWorkflow(source), id, name };
    return this.repo.createWorkflow(userId, { id, definition, isDefault: false });
  }

  async update(userId: string, id: string, definition: Omit<Workflow, 'id'>): Promise<WorkflowRecord> {
    const existing = await this.get(userId, id);
    if (!existing) throw notFound('Workflow');
    const updated = await this.repo.updateWorkflow(userId, id, { definition: { ...definition, id } });
    if (!updated) throw notFound('Workflow');
    return updated;
  }

  async remove(userId: string, id: string): Promise<void> {
    const all = await this.list(userId);
    const target = all.find((w) => w.id === id);
    if (!target) throw notFound('Workflow');
    if (all.length <= 1) throw conflict('Cannot delete the last workflow');
    await this.repo.deleteWorkflow(userId, id);
    if (target.isDefault) {
      const next = all.find((w) => w.id !== id);
      if (next) await this.repo.updateWorkflow(userId, next.id, { isDefault: true });
    }
  }

  private async resolveCloneSource(userId: string, cloneFrom?: string): Promise<Workflow> {
    if (!cloneFrom) return FULL_SDLC_WORKFLOW;
    const own = await this.get(userId, cloneFrom);
    if (own) return toWorkflow(own);
    const bundled = BUNDLED_WORKFLOWS.find((w) => w.id === cloneFrom);
    if (bundled) return bundled;
    throw notFound('Workflow to clone');
  }

  private seed(userId: string): Promise<WorkflowRecord[]> {
    const inFlight = this.seeding.get(userId);
    if (inFlight) return inFlight;
    const promise = (async () => {
      try {
        const records: WorkflowRecord[] = [];
        for (const [index, bundled] of BUNDLED_WORKFLOWS.entries()) {
          const id = randomUUID();
          records.push(await this.repo.createWorkflow(userId, { id, definition: { ...snapshotWorkflow(bundled), id }, isDefault: index === 0 }));
        }
        return records;
      } finally {
        this.seeding.delete(userId);
      }
    })();
    this.seeding.set(userId, promise);
    return promise;
  }
}
