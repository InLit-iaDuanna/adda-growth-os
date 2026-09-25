import type { JsonRepository } from '../../db/src/repository';
import { advanceBackgroundRuns } from '../../domain/src/control-runs';

/** One atomic file-dev checkpoint batch. Two workers serialize through the same
 * repository lock; no network/LLM/delivery side effects occur under the lock. */
export async function processControlRunsOnce(repository: JsonRepository, now = new Date().toISOString()): Promise<number> {
  return repository.mutate(state => advanceBackgroundRuns(state, now));
}
