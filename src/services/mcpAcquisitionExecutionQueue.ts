import { AcquisitionExecutionUnavailable, prepareAcquisitionExecution } from './mcpAcquisitionExecution.js';

/** One installer pipeline at a time; capacity includes running, queued and validating requests. */
export class AcquisitionExecutionQueue {
  private pending = 0;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly prepare = prepareAcquisitionExecution, private readonly capacity = 4) {}
  get size() { return this.pending; }
  async enqueue(owner: string, operationId: string, credentials: Record<string, string> = {}) {
    if (this.pending >= this.capacity) throw new AcquisitionExecutionUnavailable('Acquisition execution queue is full');
    this.pending++;
    let execute: Awaited<ReturnType<typeof prepareAcquisitionExecution>>;
    try { execute = await this.prepare(owner, operationId, credentials); }
    catch (error) { this.pending--; throw error; }
    if (!execute) { this.pending--; return { accepted: false }; }
    const job = this.tail.then(execute);
    this.tail = job.then(() => { this.pending--; }, () => { this.pending--; });
    return { accepted: true };
  }
  async drain() { await this.tail; }
}
const queue = new AcquisitionExecutionQueue();
export const enqueueAcquisitionExecution = (owner: string, operationId: string, credentials: Record<string, string> = {}) =>
  queue.enqueue(owner, operationId, credentials);
