/**
 * 串行队列：保证读-改-写不交错。
 * 前一个任务失败不会阻断后续任务；失败只影响调用者拿到的 Promise。
 */
export function createQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const run = tail.then(() => task());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
