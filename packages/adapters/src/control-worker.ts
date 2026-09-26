import type { JsonRepository } from '../../db/src/repository';
import { readConfig, type AppConfig } from './config';
import { runCodeBuddyRole } from './codebuddy';
import { advanceBackgroundRuns, claimLiveBackgroundRun, commitLiveBackgroundRun } from '../../domain/src/control-runs';
import { buildControlProviderPrompt, normalizeControlProviderResult } from '../../domain/src/control-service';

/** One atomic file-dev checkpoint batch. Two workers serialize through the same
 * repository lock; a live provider call happens between claim and commit. */
export async function processControlRunsOnce(repository: JsonRepository, now = new Date().toISOString(), config: AppConfig = readConfig()): Promise<number> {
  if (config.aiProvider === 'deterministic_offline') return repository.mutate(state => advanceBackgroundRuns(state, now));
  const claim = await repository.mutate(state => claimLiveBackgroundRun(state, now));
  if (!claim) return 0;
  let outcome;
  try {
    const live = await runCodeBuddyRole(config, { role: 'agent_planner', conversationId: claim.attemptId, prompt: buildControlProviderPrompt(claim.evidence) });
    outcome = live.ok
      ? { ok: true, result: normalizeControlProviderResult(live.value), provider: 'codebuddy_cli', model: live.model, checks: live.checks as unknown as Record<string, unknown>, elapsedMs: live.elapsedMs }
      : { ok: false, errorCode: live.errorCode, message: live.message, provider: 'codebuddy_cli', model: live.model, checks: live.checks as unknown as Record<string, unknown>, elapsedMs: live.elapsedMs };
  } catch (error) {
    outcome = { ok: false, errorCode: 'external_blocked', message: error instanceof Error ? error.message : 'provider_call_failed', provider: 'codebuddy_cli', model: config.codebuddyModel };
  }
  await repository.mutate(state => commitLiveBackgroundRun(state, claim, outcome, new Date().toISOString()));
  return 1;
}
