/** One in-flight heartbeat, including while the accepted job waits in memory. */
export function startExecutionHeartbeat(touch: () => Promise<boolean>) {
  let stopped = false;
  let lost = false;
  let pending: Promise<boolean> | undefined;
  const confirm = (): Promise<boolean> => {
    if (stopped || lost) return Promise.resolve(false);
    if (pending) return pending;
    pending = Promise.resolve().then(touch).then(ok => {
      if (!ok) lost = true;
      return ok;
    }, () => { lost = true; return false; }).finally(() => { pending = undefined; });
    return pending;
  };
  const timer = setInterval(() => { void confirm(); }, 30_000);
  timer.unref();
  return { confirm, stop: () => { stopped = true; clearInterval(timer); } };
}
