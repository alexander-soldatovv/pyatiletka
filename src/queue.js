import { setTimeout as sleepDefault } from 'node:timers/promises';

function retryable(error) {
  const status = error?.status;
  return status === 429 || (Number.isInteger(status) && status >= 500);
}

export function createDialogQueue({
  minIntervalMs = 500,
  maxAttempts = 3,
  retryBaseMs = 250,
  sleep = sleepDefault,
  now = () => Date.now(),
} = {}) {
  const tails = new Map();
  const lastStarted = new Map();

  async function waitForSlot(dialogId) {
    const elapsed = now() - (lastStarted.get(dialogId) ?? 0);
    if (elapsed < minIntervalMs) await sleep(minIntervalMs - elapsed);
    lastStarted.set(dialogId, now());
  }

  async function execute(dialogId, operation) {
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await waitForSlot(dialogId);
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!retryable(error) || attempt === maxAttempts - 1) throw error;
        await sleep(retryBaseMs * (2 ** attempt));
      }
    }
    throw lastError;
  }

  function schedule(dialogId, operation) {
    const key = String(dialogId);
    const previous = tails.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => execute(key, operation));
    tails.set(key, current);
    current.finally(() => {
      if (tails.get(key) === current) tails.delete(key);
    }).catch(() => undefined);
    return current;
  }

  return { schedule };
}
