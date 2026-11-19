/** Kettenzähler je asynchronem Turn, niemals global in process.env. */
import { AsyncLocalStorage } from "node:async_hooks";

const chain = new AsyncLocalStorage<number | undefined>();
export const currentJobChain = () => chain.getStore();
export function withJobChain<T>(value: number | undefined, run: () => T): T {
  return chain.run(value, run);
}
