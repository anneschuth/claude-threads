/**
 * Run tasks one at a time per key, in the order they were submitted. Tasks
 * for different keys do not wait for each other. A task that fails does not
 * block the ones queued behind it; its error goes to the caller of that task.
 */
export function createSerialByKey<Key>(): <Result>(key: Key, task: () => Promise<Result>) => Promise<Result> {
  const tails = new Map<Key, Promise<unknown>>();
  return (key, task) => {
    const run = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => undefined).finally(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    tails.set(key, tail);
    return run;
  };
}
