/** Bounds reads only. A D1 read cannot be cancelled, and is never retried here. */
export async function readWithDeadline<T>(operation: Promise<T>, milliseconds = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('READ_DEADLINE_EXCEEDED')), milliseconds);
  });
  try { return await Promise.race([operation, deadline]); }
  finally { clearTimeout(timer); }
}
